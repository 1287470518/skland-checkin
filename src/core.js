// skland-checkin · 核心（零依赖，Node 18+）
// 流程：网页 token → (grant) 一次性 code → (generate_cred_by_code) cred + signToken
//       → 绑定列表 → 每个角色的签到请求
import crypto from 'node:crypto';
import { CheckinError, safeError } from './errors.js';

const UA = 'Skland/1.0.1 (com.hypergryph.skland; build:100001014; Android 31; ) Okhttp/4.11.0';
const V = '1.0.1';
// ⚠️ grant 的 appCode 是十六进制串，不是 "endfield"；抽卡链路用的是另一个值
const APP_CODE = '4ca99fa6b56cc2ba';
const GAMES = {
  endfield: { name: '终末地', checkinUrl: 'https://zonai.skland.com/api/v1/game/endfield/attendance' },
  arknights: { name: '明日方舟', checkinUrl: 'https://zonai.skland.com/api/v1/game/attendance' },
};

/** 标准 JSON，结构冒号后加空格、逗号后无空格；字符串内部逐字保留。
 * JSON.stringify 负责 JSON 语义（toJSON/undefined/转义等），扫描器只处理字符串外的结构分隔符。
 * 签名与发送必须使用同一份返回值；这不是完整的 Python JSON 编码兼容层。
 */
export function pyJson(o) {
  const compact = JSON.stringify(o);
  if (compact === undefined) return undefined;
  let result = '', inString = false, escaped = false;
  for (const ch of compact) {
    result += ch;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === ':') result += ' ';
  }
  return result;
}

/** 签名头：timestamp 故意减 2 秒（防时钟漂移）；h 的字段顺序必须固定 */
export function signHeaders(signToken, pathname, bodyStr, extra = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000) - 2);
  const h = { platform: '1', timestamp, dId: '', vName: V };
  const hex = crypto.createHmac('sha256', signToken).update(pathname + bodyStr + timestamp + JSON.stringify(h)).digest('hex');
  return { ...extra, sign: crypto.createHash('md5').update(hex).digest('hex'), ...h, 'User-Agent': UA };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 只重试「网络层/5xx」这类瞬时错误；业务错误（code≠0）不重试，避免重复消费一次性 code */
const isTransient = (e, status) => status >= 500 || status === 429 || /fetch failed|ETIMEDOUT|ECONNRESET|aborted|timeout/i.test(String(e && e.message));

/** 限量读响应正文：有流就按字节流读，避免超大响应先整块进内存（审查 L07） */
async function readBody(res, limit) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* 取消失败不影响报错 */ }
        throw new CheckinError('STRUCTURE', { status: res.status });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > limit) throw new CheckinError('STRUCTURE', { status: res.status });
  return text;
}

async function requestOnce(url, { body, cred, signToken, method = 'POST', fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const u = new URL(url);
  const bs = method === 'GET' ? u.search.slice(1) : (body === undefined ? '' : pyJson(body));
  const headers = signToken
    ? signHeaders(signToken, u.pathname, bs, cred ? { cred } : {})
    : { 'User-Agent': UA };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(url, {
    method, headers,
    ...(method === 'POST' && body !== undefined ? { body: bs } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await readBody(res, 5 * 1024 * 1024);
  let json;
  try { json = JSON.parse(text); }
  catch { throw new CheckinError('NON_JSON', { status: res.status }); }
  return { status: res.status, json };
}

/** 校验一次响应的「可接受性」：HTTP 与业务 code 都要看 */
const record = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const nonemptyString = (v) => typeof v === 'string' && v.length > 0;
// 角色 ID 允许非空字符串或安全整数；对象/数组/空值一律不发请求（审查 M05）。
const idish = (v) => (typeof v === 'string' && v.length > 0) || Number.isSafeInteger(v);
function assertOk(out, operation, { requireCode = true } = {}) {
  if (!Number.isInteger(out.status) || out.status < 200 || out.status >= 300) throw new CheckinError('HTTP', { operation, status: out.status });
  if (!record(out.json)) throw new CheckinError('STRUCTURE', { operation });
  // ⚠️ 2026-10-21 实测修正：**不是所有接口都有顶层 code**。
  //   grant 的真实响应是 {"data":{uid,code,token},"msg":"OK","status":0,"type":"A"} —— 它用 status 表示结果。
  //   （原实现要求 code 必须是整数 ⇒ 真接口一进来就被判「结构错误」，是回归 bug）
  const code = out.json.code;
  if (code === undefined) {
    if (requireCode) throw new CheckinError('STRUCTURE', { operation });     // 绑定/签到这类必须带 code
    if (out.json.status !== undefined && out.json.status !== 0) throw new CheckinError('BUSINESS', { operation, code: out.json.status });
    return;
  }
  if (!Number.isSafeInteger(code)) throw new CheckinError('STRUCTURE', { operation });
  if (code !== 0) throw new CheckinError('BUSINESS', { operation, code });
}

/** 默认最多 3 次，退避 2s / 10s；一次性兑换和签到在各自调用处强制关闭重放。 */
async function request(url, opts = {}) {
  const retries = opts.retries === undefined ? 2 : opts.retries;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const out = await requestOnce(url, opts);
      if (isTransient(null, out.status) && attempt < retries) { await sleep([2000, 10000][attempt] || 10000); continue; }
      return out;
    } catch (e) {
      lastErr = e;
      const transient = isTransient(e, e instanceof CheckinError ? e.status : 0);
      if (!transient || attempt >= retries) throw e;
      await sleep([2000, 10000][attempt] || 10000);
    }
  }
  throw lastErr;
}

/** ① 网页 token → 一次性 code（这一步不带签名） */
export async function grantCode(token, opts = {}) {
  // grant 申请新 code，不消费已有 code；保留有限的瞬时故障重试。
  const out = await request('https://as.hypergryph.com/user/oauth2/v2/grant', {
    ...opts, body: { appCode: APP_CODE, token, type: 0 },
  });
  assertOk(out, 'grant', { requireCode: false });   // grant 用 status 表示结果，没有顶层 code
  // ⚠️ 2026-10-21 终审补充：grant **只要 status 不是 0 就失败**。
  //   上面 assertOk 在「有 code 且 code===0」时会直接 return，跳过 status 检查；
  //   缺 status 时也不会检查 —— 两种情况都必须在这里兜住。
  if (out.json.status !== 0) throw new CheckinError('BUSINESS', { operation: 'grant', code: out.json.status });
  if (!record(out.json.data) || !nonemptyString(out.json.data.code)) throw new CheckinError('STRUCTURE', { operation: 'grant' });
  return out.json.data.code;
}

/** ② code → cred + signToken（同样不带签名，kind 固定 1） */
export async function exchangeCred(code, opts = {}) {
  // ⚠️ **绝不重试**：code 只能用一次，重放会被服务端拒绝，也可能让状态更难判断
  const out = await request('https://zonai.skland.com/api/v1/user/auth/generate_cred_by_code', {
    ...opts, body: { code, kind: 1 }, retries: 0,
  });
  assertOk(out, '换 cred');
  const { json } = out;
  if (!record(json.data) || !nonemptyString(json.data.cred) || !nonemptyString(json.data.token) ||
      (json.data.userId !== undefined && typeof json.data.userId !== 'string')) throw new CheckinError('STRUCTURE', { operation: '换 cred' });
  return { cred: json.data.cred, signToken: json.data.token, userId: json.data.userId || '' };
}

/** 一步到位：token → 凭据 */
export async function login(token, opts = {}) {
  return exchangeCred(await grantCode(token, opts), opts);
}

/** ③ 绑定列表（GET，不是 POST；数据在 data.list） */
export async function getBindings(cred, signToken, opts = {}) {
  const out = await request('https://zonai.skland.com/api/v1/game/player/binding', {
    cred, signToken, method: 'GET', ...opts,
  });
  assertOk(out, '取绑定列表');
  const list = out.json.data && out.json.data.list;
  if (!Array.isArray(list) || list.some((app) => !record(app) || !nonemptyString(app.appCode) || !Array.isArray(app.bindingList))) throw new CheckinError('STRUCTURE', { operation: '取绑定列表' });
  return list;   // 空数组是合法结果（账号确实没绑角色），与「取失败」区分开
}

/** ④ 给一个角色签到。返回 { ok, already, code, message, awards } */
export async function checkinRole(role, appCode, cred, signToken, opts = {}) {
  const game = Object.hasOwn(GAMES, appCode) ? GAMES[appCode] : null;
  if (!game) return { ok: false, already: false, code: null, message: '未知游戏', awards: [] };
  if (!record(role)) throw new CheckinError('STRUCTURE', { operation: '签到' });
  let body;
  if (appCode === 'endfield') {
    const dr = role.defaultRole || {};
    if (!idish(role.uid) || !idish(dr.roleId) || !idish(dr.serverId)) return { ok: false, already: false, code: null, message: '该绑定缺少必要角色信息（uid/roleId/serverId）', awards: [] };
    body = { uid: role.uid, gameId: 3, roleId: dr.roleId, serverId: dr.serverId };
  } else {
    if (!idish(role.uid) || !idish(role.channelMasterId)) return { ok: false, already: false, code: null, message: '该绑定缺少必要角色信息（uid/channelMasterId）', awards: [] };
    body = { uid: role.uid, gameId: role.channelMasterId };
  }
  // ⚠️ 签到不重试（审查 H04）：POST 的响应丢了再重发，可能从「本次成功」变成「已签」
  const out = await request(game.checkinUrl, { body, cred, signToken, ...opts, retries: 0 });
  if (!Number.isInteger(out.status) || out.status < 200 || out.status >= 300) return { ok: false, already: false, code: null, message: '签到结果未知：' + new CheckinError('HTTP', { operation: '签到', status: out.status }).message, awards: [] };
  const json = out.json;
  if (!record(json) || !Number.isSafeInteger(json.code)) throw new CheckinError('STRUCTURE', { operation: '签到' });
  const code = json.code;
  return {
    ok: code === 0,
    already: code === 10001,
    code,
    message: code === 0 ? '签到成功' : code === 10001 ? '已经签过' : '签到失败（业务错误）',
    awards: Array.isArray(json.data?.awards) ? json.data.awards.map((a) => typeof a?.resource?.name === 'string' ? a.resource.name : '?') : [],
  };
}

/** 全流程：一个 token 签完所有绑定角色 */
export async function checkinToken(token, { cred, fetchImpl, delayMs = 400 } = {}) {
  const opts = { fetchImpl };
  const c = cred || await login(token, opts);
  const apps = await getBindings(c.cred, c.signToken, opts);
  const results = [];
  for (const app of apps) {
    for (const role of (app.bindingList || [])) {
      let label = '未知角色';
      // 单个角色失败不中断整批（审查 M05）
      let r;
      try {
        if (!record(role)) throw new CheckinError('STRUCTURE', { operation: '签到' });
        label = (app.appCode === 'endfield' ? ((role.defaultRole || {}).nickname) : role.nickName) || role.uid || label;
        r = await checkinRole(role, app.appCode, c.cred, c.signToken, opts);
      }
      catch (e) { r = { ok: false, already: false, code: null, message: '签到结果未知：' + safeError(e), awards: [] }; }
      results.push({ appCode: app.appCode, label, ...r });
      if (delayMs) await new Promise((r2) => setTimeout(r2, delayMs));
    }
  }
  return { cred: c, results };
}
