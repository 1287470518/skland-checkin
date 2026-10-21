// 本地 UI：账号列表 + 登录/取 token/删除/立即签到。只监听 127.0.0.1。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkinToken, getBindings, login } from './core.js';
import { CredStore } from './store.js';
import { State, keyOf } from './state.mjs';
import { acquireLock } from './lock.js';
import { BrowserSession, readToken, findBrowser } from './browser.mjs';
import { spawn } from 'node:child_process';
import { safeError } from './errors.js';
import { installDailyTask, removeDailyTask, taskNameFor, installBootTask, removeBootTask, bootTaskInstalled } from './scheduler.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SKLAND_UI_PORT || 8977);
const HOST = '127.0.0.1';
const TOKENS = path.join(ROOT, 'tokens.txt');
const state = new State();
const session = new BrowserSession(path.join(state.dir, 'browser-profile'));

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('请求体太大')); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const hostOk = (req) => {
  const m = /^(127\.0\.0\.1|localhost):(\d+)$/.exec(String(req.headers.host || ''));
  return !!m && Number(m[2]) === port;
};
const originOk = (req) => {
  const o = req.headers.origin;
  if (o) return o === 'http://127.0.0.1:' + port || o === 'http://localhost:' + port;
  return req.headers['x-skland-checkin'] === '1';
};

const json = (res, status, obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
};

function readTokens() {
  try {
    return fs.readFileSync(TOKENS, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => { try { const o = JSON.parse(l); return typeof o.token === 'string' ? { name: o.name || '', token: o.token } : null; } catch { return { name: '', token: l }; } })
      .filter((x) => x && x.token);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error('tokens.txt 读不出来（' + (e.code || 'unknown') + '）');
  }
}
function writeTokens(list) {
  const lines = ['# 一行一个 token（不要提交到 git）', ...list.map((a) => a.token)];
  const tmp = TOKENS + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, TOKENS);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原错误 */ }
    throw e;
  }
}
function appendToken(token) {
  const list = readTokens();
  if (!list.some((a) => a.token === token)) { list.push({ name: '', token }); writeTokens(list); }
}
function removeToken(token) {
  writeTokens(readTokens().filter((a) => a.token !== token));
  state.remove(token);
}

const accountsView = () => readTokens().map((a) => {
  const s = state.get(a.token) || {};
  return {
    key: keyOf(a.token),
    nickname: s.nickname || a.name || '',
    signedToday: state.signedToday(a.token),
    lastSuccess: s.lastSuccess || null,
    lastAttempt: s.lastAttempt || null,
    lastError: s.lastError || null,
  };
});

async function doCheckinAll() {
  const list = readTokens();
  const store = new CredStore();
  const release = await acquireLock(store.dir);
  const results = [];
  try {
  for (const a of list) {
    if (state.signedToday(a.token)) { results.push({ key: keyOf(a.token), skipped: true }); continue; }
    try {
      const cred = store.get(a.token);
      const { cred: used, results: rs } = await checkinToken(a.token, { cred });
      if (!cred) { try { store.put(a.token, used); } catch { /* 缓存失败不影响结果 */ } }
      const ok = rs.length > 0 && rs.every((r) => r.ok || r.already);
      if (ok) state.markSuccess(a.token, rs[0] && rs[0].label);
      else state.markAttempt(a.token, '有角色失败');
      results.push({ key: keyOf(a.token), ok, count: rs.length });
    } catch (e) {
      state.markAttempt(a.token, safeError(e));
      results.push({ key: keyOf(a.token), ok: false, error: safeError(e) });
    }
  }
  return results;
  } finally { release(); }
}

const HTML = String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>森空岛签到助手</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
.wrap{max-width:760px;margin:24px auto;padding:0 18px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#94a3b8;margin-bottom:18px}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
button{cursor:pointer;border:0;border-radius:8px;padding:10px 16px;font-size:14px;background:#2563eb;color:#fff}
button.ghost{background:#1e293b;color:#cbd5e1}button:disabled{opacity:.5;cursor:not-allowed}
.list{background:#111c33;border:1px solid #1e293b;border-radius:10px;overflow:hidden}
.row{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #1e293b}
.row:last-child{border-bottom:0}.name{flex:1}.ok{color:#34d399}.bad{color:#f87171}.muted{color:#64748b;font-size:12px}
.msg{margin-top:14px;min-height:22px;color:#93c5fd}.err{color:#f87171}
</style></head><body><div class="wrap">
<h1>森空岛签到助手</h1>
<div class="sub">明日方舟 / 终末地 · 登录一次，之后每天自动签到</div>
<div class="btns">
  <button id="login">① 登录森空岛</button>
  <button id="token">② 获取 token 并绑定</button>
  <button class="ghost" id="checkin">立即签到</button>
</div>
<label class="auto"><input type="checkbox" id="auto"> 开机自启（登录时静默签到一次）</label>
<div class="list" id="list"></div>
<div class="msg" id="msg"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const api = async (method, url, body) => { const r = await fetch(url, { method, headers: { 'X-Skland-Checkin': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; };
async function refresh() {
  const j = await api('GET', '/api/status');
  $('auto').checked = !!j.autostart;
  const list = $('list');
  list.textContent = '';
  if (!j.accounts.length) { const d = document.createElement('div'); d.className = 'row muted'; d.textContent = '还没有绑定账号。点上面两个按钮。'; list.appendChild(d); return; }
  for (const a of j.accounts) {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('div'); name.className = 'name';
    name.textContent = a.nickname || ('账号 ' + a.key.slice(0, 6));
    const st = document.createElement('div');
    st.className = a.signedToday ? 'ok' : 'muted';
    st.textContent = a.signedToday ? '今天已签' : (a.lastError ? '上次失败' : '今天未签');
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '删除';
    del.onclick = async () => { if (!confirm('删除这个账号？')) return; await api('DELETE', '/api/account/' + a.key); refresh(); };
    row.append(name, st, del); list.appendChild(row);
  }
}
function msg(t, err) { $('msg').textContent = t || ''; $('msg').className = 'msg' + (err ? ' err' : ''); }
async function run(btn, fn) { btn.disabled = true; try { await fn(); } catch (e) { msg(String(e.message || e), true); } finally { btn.disabled = false; } }
$('login').onclick = () => run($('login'), async () => { msg('正在打开登录页，登录完再点第 ② 个按钮…'); await api('POST', '/api/login'); msg('登录页已打开，登录完成后点「获取 token 并绑定」'); refresh(); });
$('token').onclick = () => run($('token'), async () => { msg('正在读取 token…'); const j = await api('POST', '/api/token'); msg('已绑定 ' + (j.nickname || '账号') + (j.warning ? '（' + j.warning + '）' : '')); refresh(); });
$('auto').onchange = async () => {
  try { await api('POST', '/api/autostart', JSON.stringify({ enabled: $('auto').checked })); msg($('auto').checked ? '已开启开机自启' : '已关闭开机自启'); }
  catch (e) { msg(String(e.message || e), true); }
};
$('checkin').onclick = () => run($('checkin'), async () => { msg('正在签到…'); const j = await api('POST', '/api/checkin'); msg('签到完成：' + JSON.stringify(j.results)); refresh(); });
refresh();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return json(res, 403, { error: '只接受本机访问' });
    if (req.method !== 'GET' && !originOk(req)) return json(res, 403, { error: '跨站请求被拒绝' });
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      const daily = path.join(ROOT, 'src', 'daily.mjs');
      return json(res, 200, { accounts: accountsView(), task: taskNameFor(ROOT), autostart: bootTaskInstalled(daily) });
    }
    if (req.method === 'POST' && req.url === '/api/login') {
      await session.ensure();
      await session.navigate('https://www.skland.com/');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/token') {
      let token;
      try { token = await readToken(session); }
      finally { await session.close(); }
      const cred = await login(token);
      const apps = await getBindings(cred.cred, cred.signToken);
      const names = apps.flatMap((a) => a.bindingList.map((b) => b.nickName || b.uid).filter(Boolean));
      const nickname = names[0] || '';
      appendToken(token);
      state.set(token, { nickname, userId: cred.userId || '', addedAt: new Date().toISOString() });
      const store = new CredStore();
      try { store.put(token, cred); } catch { /* 缓存失败不影响绑定 */ }
      let warning = null;
      try { installDailyTask({ cliPath: path.join(ROOT, 'src', 'daily.mjs'), tokensPath: TOKENS }); }
      catch (e) { warning = '自动签到任务没装上（' + safeError(e) + '），可以稍后手动双击「设置每天自动签到.bat」'; }
      return json(res, 200, { ok: true, nickname, warning });
    }
    if (req.method === 'DELETE' && req.url.startsWith('/api/account/')) {
      const key = decodeURIComponent(req.url.slice('/api/account/'.length));
      const hit = readTokens().find((a) => keyOf(a.token) === key);
      if (hit) removeToken(hit.token);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/autostart') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const daily = path.join(ROOT, 'src', 'daily.mjs');
      if (body.enabled) installBootTask({ cliPath: daily, tokensPath: TOKENS });
      else removeBootTask(daily);
      return json(res, 200, { ok: true, autostart: bootTaskInstalled(daily) });
    }
    if (req.method === 'POST' && req.url === '/api/checkin') {
      const results = await doCheckinAll();
      return json(res, 200, { ok: true, results });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 502, { error: safeError(e) });
  }
});

let port = PORT;
let started = false;
function start() {
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.removeListener('error', onError);
    if (started) return;
    started = true;
    console.log('签到助手已启动：http://' + HOST + ':' + port);
    openAppWindow(port);
    // 启动时检查今天有没有签过：没签就签一次（不是补签，就是今天还没签）
    doCheckinAll().catch(() => {});
  });
}
function onError(e) {
  if (e && e.code === 'EADDRINUSE' && port < PORT + 8) { port++; start(); return; }
  console.error('启动失败：' + e.message);
  process.exit(1);
}
start();

function openAppWindow(p) {
  try {
    const exe = findBrowser();
    if (!exe) return;
    const dir = path.join(state.dir, 'ui-profile');
    fs.mkdirSync(dir, { recursive: true });
    const proc = spawn(exe, ['--app=http://' + HOST + ':' + p, '--user-data-dir=' + dir, '--no-first-run', '--no-default-browser-check', '--window-size=860,680'], { detached: true, stdio: 'ignore' });
    proc.unref();
  } catch { /* 没有浏览器也不影响服务本身 */ }
}
