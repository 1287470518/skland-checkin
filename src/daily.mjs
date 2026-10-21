// 定时任务入口：读 tokens.txt 逐账号签到；今天已签跳过；失败等一会再试一次。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkinToken } from './core.js';
import { CredStore } from './store.js';
import { State } from './state.mjs';
import { safeError } from './errors.js';
import { acquireLock } from './lock.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argFile = process.argv.indexOf('--token-file');
const TOKENS = argFile > -1 ? process.argv[argFile + 1] : path.join(ROOT, 'tokens.txt');
const state = new State();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readTokens() {
  try {
    return fs.readFileSync(TOKENS, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => { try { const o = JSON.parse(l); return typeof o.token === 'string' ? { name: o.name || '', token: o.token } : null; } catch { return { name: '', token: l }; } })
      .filter((x) => x && x.token);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.error('tokens.txt 读不出来：' + (e.code || 'unknown'));
    process.exit(1);
  }
}

async function once(a, store) {
  const cred = store.get(a.token);
  const { cred: used, results } = await checkinToken(a.token, { cred });
  if (!cred) { try { store.put(a.token, used); } catch { /* 缓存失败不影响 */ } }
  const ok = results.length > 0 && results.every((r) => r.ok || r.already);
  if (ok) state.markSuccess(a.token, results[0] && results[0].label);
  else state.markAttempt(a.token, '有角色失败');
  return ok;
}

const list = readTokens();
if (!list.length) { console.log('没有账号，跳过'); process.exit(0); }
const store = new CredStore();
const release = await acquireLock(store.dir);
process.on('exit', release);
const failed = [];
const roleFailed = [];
for (const a of list) {
  if (state.signedToday(a.token)) { console.log('今天已签，跳过：' + (state.get(a.token) || {}).nickname || ''); continue; }
  try {
    const ok = await once(a, store);
    console.log((ok ? '签到完成：' : '有角色失败（不重放，避免重复签到）') + ((state.get(a.token) || {}).nickname || ''));
    if (!ok) roleFailed.push({ a, ok: false });
  } catch (e) {
    state.markAttempt(a.token, safeError(e));
    console.log('失败：' + safeError(e));
    failed.push(a);
  }
}
// 失败的重试一次（「失败就晚点再签」）
let remaining = 0;
for (const a of failed) {
  await sleep(60000);
  try {
    const ok = await once(a, store);
    console.log((ok ? '重试成功：' : '重试仍失败：') + ((state.get(a.token) || {}).nickname || ''));
    if (!ok) remaining++;
  } catch (e) { state.markAttempt(a.token, safeError(e)); console.log('重试失败：' + safeError(e)); remaining++; }
}
if (roleFailed.length || remaining) { console.log('有账号没签成功'); process.exit(1); }
process.exit(0);
