#!/usr/bin/env node
// 极简本地 UI —— 零依赖，只监听 127.0.0.1
// 安全：① 只绑本机 ② 严格同源（见 sameOrigin） ③ 不回显 token ④ 顶层错误边界
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkinToken } from './core.js';
import { CredStore } from './store.js';
import crypto from 'node:crypto';
import { safeError, safeCacheError } from './errors.js';
import { acquireLock, BusyError } from './lock.js';
import { tokenInputError } from './input.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.SKLAND_UI_PORT || 8977);
const HOST = '127.0.0.1';                       // ⚠️ 绝不改成 0.0.0.0
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('SKLAND_UI_PORT 不合法（须为 1–65535 的整数）');
  process.exit(2);
}
const OK_ORIGINS = new Set(['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT]);

const json = (res, status, obj) => {
  if (res.headersSent) return;
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
};

/** Host 必须是本机回环（防 DNS rebinding） */
function hostOk(req) {
  return /^(127\.0\.0\.1|localhost):\d+$/.test(String(req.headers.host || ''));
}

/**
 * 写操作（POST）的严格同源：
 *  - 浏览器同源 fetch 一定带 Origin ⇒ 必须命中本服务的 origin；
 *  - 非浏览器（curl/脚本）没有 Origin ⇒ 必须显式带 X-Skland-Checkin: 1。
 * 读页面（GET）只查 Host —— 浏览器导航本来就不带 Origin。
 */
function originOk(req) {
  const origin = req.headers.origin;
  if (origin) return OK_ORIGINS.has(origin);
  return req.headers['x-skland-checkin'] === '1';
}

class BodyTooLarge extends Error {}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new BodyTooLarge()); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 同一个 token 的并发请求返回 429；完整 SHA256 作键，不共享其他请求的结果。
const inflight = new Map();

async function handle(req, res) {
  if (!hostOk(req)) return json(res, 403, { error: '只接受本机访问' });

  let url;
  try { url = new URL(req.url, 'http://' + HOST + ':' + PORT); }
  catch { return json(res, 400, { error: '请求地址不合法' }); }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    let html;
    try { html = fs.readFileSync(path.join(PUBLIC, 'index.html')); }
    catch (e) { return json(res, 500, { error: '页面文件缺失' }); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  if (req.method === 'POST' && url.pathname === '/api/checkin') {
    if (!originOk(req)) return json(res, 403, { error: '只接受本机同源请求' });
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || '{}');
    } catch (e) {
      if (e instanceof BodyTooLarge) return json(res, 413, { error: '请求体太大' });
      return json(res, 400, { error: '请求格式不对' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: '请求体必须是 JSON 对象' });
    const inputError = tokenInputError(body.token);
    if (inputError) return json(res, 400, { error: inputError });
    const token = body.token.trim();

    const key = crypto.createHash('sha256').update(token).digest('hex');
    if (inflight.has(key)) return json(res, 429, { error: '这个账号正在签到，稍等几秒再试' });
    const task = (async () => {
      const store = new CredStore();
      const release = acquireLock(store.dir);   // 跨进程互斥（审查 M01）
      try {
      let cred = body.noCache ? null : store.get(token);
      const { cred: used, results } = await checkinToken(token, { cred });
      // ⚠️ 缓存写失败不能把签到结果变成 502（审查 M03）；单独回报 cacheError
      let cacheError = null;
      if (!cred) {
        try { store.put(token, used); }
        catch { cacheError = safeCacheError(); }
      }
      return {
        summary: {
          ok: results.filter((r) => r.ok).length,
          already: results.filter((r) => r.already).length,
          bad: results.filter((r) => !r.ok && !r.already).length,
          total: results.length,
        },
        // ⚠️ 只挑白名单字段；绝不把 token/cred 回给前端
        results: results.map((r) => ({ appCode: r.appCode, label: r.label, ok: r.ok, already: r.already, message: r.message, awards: r.awards })),
        ...(cacheError ? { cacheError } : {}),
      };
      } finally { release(); }
    })();
    inflight.set(key, task);
    try {
      const out = await task;
      return json(res, 200, out);
    } catch (e) {
      if (e instanceof BusyError) return json(res, 409, { error: '另一个签到实例正在运行，稍后再试' });
      return json(res, 502, { error: safeError(e) });
    } finally {
      inflight.delete(key);
    }
  }

  return json(res, 404, { error: '没有这个路径' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    // 顶层错误边界：任何未捕获的异常都回 500，不让进程崩（审查 M02）
    const errorId = crypto.randomUUID();
    console.error('[request-error ' + errorId + '] ' + safeError(e));
    try { json(res, 500, { error: '服务器内部错误' }); } catch { /* 已经断了就算了 */ }
  });
});

server.on('error', (e) => {
  console.error('启动失败：' + safeError(e) + (e && e.code === 'EADDRINUSE' ? '（端口被占用，换 SKLAND_UI_PORT）' : ''));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('森空岛签到 UI 已启动： http://' + HOST + ':' + PORT);
  console.log('（只监听本机；关掉这个窗口即停止）');
});
