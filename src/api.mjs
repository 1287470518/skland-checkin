// 给其它程序 / QQ 机器人用的接口：导入后直接调用（不启动 UI、不打印结果）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkinToken } from './core.js';
import { CredStore } from './store.js';
import { State, keyOf, localDate } from './state.mjs';
import { acquireLock } from './lock.js';
import { safeError } from './errors.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const tokensPath = path.join(ROOT, 'tokens.txt');

export function listAccounts() {
  let lines;
  try { lines = fs.readFileSync(tokensPath, 'utf8').split('\n'); } catch { return []; }
  return lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { try { const o = JSON.parse(l); return typeof o.token === 'string' ? { name: o.name || '', token: o.token } : null; } catch { return { name: '', token: l }; } })
    .filter((x) => x && x.token)
    .map((a) => ({ key: keyOf(a.token), name: a.name, token: a.token, state: new State().get(a.token) }));
}

/** 签到一个 token；返回 { key, ok, results } 或 { key, error } */
export async function checkinOne(token, { store = new CredStore() } = {}) {
  const release = await acquireLock(store.dir);
  try {
    const cred = store.get(token);
    const { cred: used, results } = await checkinToken(token, { cred });
    if (!cred) { try { store.put(token, used); } catch { /* 缓存失败不影响结果 */ } }
    const ok = results.length > 0 && results.every((r) => r.ok || r.already);
    const st = new State();
    if (ok) st.markSuccess(token, results[0] && results[0].label);
    else st.markAttempt(token, '有角色失败');
    return { key: keyOf(token), ok, results };
  } catch (e) {
    try { new State().markAttempt(token, safeError(e)); } catch { /* 状态写失败不掩盖签到错误 */ }
    return { key: keyOf(token), ok: false, error: safeError(e) };
  } finally { release(); }
}

/** 签到所有账号；今天已签的跳过（除非 force） */
export async function checkinAll({ force = false } = {}) {
  const st = new State();
  const out = [];
  for (const a of listAccounts()) {
    if (!force && st.signedToday(a.token)) { out.push({ key: a.key, skipped: true }); continue; }
    out.push(await checkinOne(a.token));
  }
  return out;
}

export { localDate };
