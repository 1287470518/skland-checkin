// 独立浏览器会话：启动 Edge/Chrome（独立 profile + 调试端口），用 CDP 读页面。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

export function findBrowser() {
  for (const p of CANDIDATES) { try { if (p && fs.existsSync(p)) return p; } catch { /* 继续找 */ } }
  return null;
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.waiting = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(method + ' 超时')); } }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export class BrowserSession {
  constructor(profileDir, { port } = {}) {
    this.profileDir = profileDir;
    this.port = port || (9339 + (process.pid % 100));
    this.proc = null;
  }
  async ensure() {
    if (this.proc) return;
    if (this.starting) { await this.starting; return; }
    this.starting = this._start();
    try { await this.starting; } finally { this.starting = null; }
  }
  async _start() {
    // 端口被占（可能是别的调试浏览器）就换一个，避免连到别人的会话
    let free = false;
    for (let i = 0; i < 10; i++) {
      try { await fetch('http://127.0.0.1:' + this.port + '/json/version'); this.port++; }
      catch { free = true; break; }
    }
    if (!free) throw new Error('没有可用的调试端口');
    const exe = findBrowser();
    if (!exe) throw new Error('没有找到 Edge 或 Chrome');
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.proc = spawn(exe, [
      '--remote-debugging-port=' + this.port,
      '--user-data-dir=' + this.profileDir,
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=BlockThirdPartyCookies,ThirdPartyStoragePartitioning',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1000,760',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    this.proc.on('error', () => { this.proc = null; });
    this.proc.on('exit', () => { this.proc = null; });
    this.proc.unref();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try { const r = await fetch('http://127.0.0.1:' + this.port + '/json/version'); if (r.ok) return; } catch { /* 等 */ }
    }
    throw new Error('浏览器启动超时');
  }
  async page() {
    const r = await fetch('http://127.0.0.1:' + this.port + '/json/list');
    const list = await r.json();
    return list.find((t) => t.type === 'page');
  }
  async navigate(url) {
    await this.ensure();
    const t = await this.page();
    if (!t) throw new Error('没有可用页面');
    const c = new CDP(t.webSocketDebuggerUrl);
    await c.ready;
    try {
      await c.send('Page.enable');
      await c.send('Page.navigate', { url });
      for (let i = 0; i < 60; i++) {
        await sleep(300);
        const s = await c.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (s.result.value === 'complete') break;
      }
      await sleep(300);
      const r = await c.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
      return String(r.result.value || '');
    } finally { c.close(); }
  }
  async close() {
    const pid = this.proc && this.proc.pid;
    this.proc = null;
    if (!pid) return;
    const code = await new Promise((resolve) => {
      try {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        k.on('exit', (c) => resolve(c));
        k.on('error', () => resolve(-1));
      } catch { resolve(-1); }
    });
    return code;
  }
}

/** 打开 token 接口页，读出 data.content；失败也会关窗口（由调用方保证）。 */
export async function readToken(session) {
  const body = await session.navigate('https://web-api.skland.com/account/info/hg');
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('token 页返回的不是 JSON（可能被拦截或页面结构变了）'); }
  if (!json || !json.data || typeof json.data.content !== 'string' || !json.data.content) {
    throw new Error('还没有登录（' + ((json && (json.message || json.msg)) || '未拿到 token') + '）');
  }
  return json.data.content;
}