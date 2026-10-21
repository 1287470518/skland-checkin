// 单元测试：用假 fetch，不碰真接口
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pyJson, signHeaders, checkinToken, checkinRole, getBindings, exchangeCred, grantCode } from '../src/core.js';
import { CheckinError, safeError } from '../src/errors.js';
import { tokenInputError } from '../src/input.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const okJson = (obj, status = 200) => ({
  status,
  text: async () => JSON.stringify(obj),
});

/** 按 URL 分派假响应 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opt = {}) => {
    calls.push({ url, opt });
    for (const [re, resp] of routes) if (re.test(url)) return resp(url, opt);
    throw new Error('假 fetch 没配这个地址：' + url);
  };
  fn.calls = calls;
  return fn;
}

test('pyJson 序列化格式与签名输入一致（冒号后带空格、逗号后不带）', () => {
  // 只生成结构分隔空格，不改写任何字符串内容。
  assert.equal(pyJson({ a: 1, b: 'x' }), '{"a": 1,"b": "x"}');
});

test('签名头包含 sign/platform/timestamp/dId/vName/UA', () => {
  const h = signHeaders('dummy-sign-token', '/api/v1/game/player/binding', '');
  for (const k of ['sign', 'platform', 'timestamp', 'dId', 'vName', 'User-Agent']) assert.ok(k in h, '缺 ' + k);
  assert.match(h.sign, /^[0-9a-f]{32}$/);           // md5 十六进制
  assert.equal(h.platform, '1');
  assert.equal(h.vName, '1.0.1');
  // timestamp 应比当前时间小 2 秒左右
  assert.ok(Math.abs(Number(h.timestamp) - (Math.floor(Date.now() / 1000) - 2)) <= 2);
});

test('checkinRole：code 0 → ok 且带奖励', async () => {
  const f = fakeFetch([[/attendance/, () => okJson({ code: 0, data: { awards: [{ resource: { name: '龙门币' } }] } })]]);
  const r = await checkinRole({ uid: 'u1', channelMasterId: 1 }, 'arknights', 'cred', 'sign', { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.already, false);
  assert.deepEqual(r.awards, ['龙门币']);
});

test('checkinRole：code 10001 → already', async () => {
  const f = fakeFetch([[/attendance/, () => okJson({ code: 10001, message: '请勿重复签到！' })]]);
  const r = await checkinRole({ uid: 'u1', channelMasterId: 1 }, 'arknights', 'cred', 'sign', { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.already, true);
});

test('checkinRole：终末地缺默认角色 → 明确报错，不发请求', async () => {
  const f = fakeFetch([]);
  const r = await checkinRole({ uid: 'u1', defaultRole: {} }, 'endfield', 'cred', 'sign', { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.message, /缺少必要角色信息/);
  assert.equal(f.calls.length, 0, '不该发请求');
});

test('checkinRole：畸形角色字段 → 不发请求（审查 M05）', async () => {
  const f = fakeFetch([]);
  const r1 = await checkinRole({ uid: {}, channelMasterId: [] }, 'arknights', 'c', 's', { fetchImpl: f });
  assert.equal(r1.ok, false);
  assert.equal(f.calls.length, 0, '方舟畸形角色不该发请求');
  const r2 = await checkinRole({ uid: 'u', defaultRole: { roleId: {}, serverId: [] } }, 'endfield', 'c', 's', { fetchImpl: f });
  assert.equal(r2.ok, false);
  assert.equal(f.calls.length, 0, '终末地畸形角色不该发请求');
});

test('checkinToken 全流程：grant → cred → 绑定 → 两个角色', async () => {
  const f = fakeFetch([
    [/user\/oauth2\/v2\/grant/, () => okJson({ data: { code: 'one-shot-code' }, msg: 'OK', status: 0, type: 'A' })],
    [/generate_cred_by_code/, () => okJson({ code: 0, data: { cred: 'C1', token: 'S1', userId: 'U1' } })],
    [/player\/binding/, () => okJson({ code: 0, data: { list: [
      { appCode: 'arknights', bindingList: [{ uid: 'a1', nickName: '阿米娅', channelMasterId: 1 }] },
      { appCode: 'endfield', bindingList: [{ uid: 'e1', defaultRole: { nickname: '管理员', roleId: 'r1', serverId: 's1' } }] },
    ] } })],
    [/game\/attendance/, () => okJson({ code: 0, data: { awards: [] } })],
    [/game\/endfield\/attendance/, () => okJson({ code: 10001, message: '请勿重复签到！' })],
  ]);
  const { results } = await checkinToken('fake-token-1234567890', { fetchImpl: f, delayMs: 0 });
  assert.equal(results.length, 2);
  const arch = results.find((r) => r.appCode === 'arknights');
  const endf = results.find((r) => r.appCode === 'endfield');
  assert.equal(arch.ok, true);
  assert.equal(endf.already, true);
  // 换凭据两步都用 pyJson，且不带签名
  const grantCall = f.calls.find((c) => /grant/.test(c.url));
  assert.equal(grantCall.opt.method, 'POST');
  assert.equal(grantCall.opt.headers.sign, undefined, 'grant 不该带签名');
  assert.equal(grantCall.opt.body, pyJson({ appCode: '4ca99fa6b56cc2ba', token: 'fake-token-1234567890', type: 0 }));
  // 绑定是 GET
  const bindCall = f.calls.find((c) => /binding/.test(c.url));
  assert.equal(bindCall.opt.method, 'GET');
});

test('checkinToken：grant 失败要抛错，不静默', async () => {
  const f = fakeFetch([[/grant/, () => okJson({ code: 400, msg: 'bad' }, 400)]]);
  await assert.rejects(() => checkinToken('bad-token-1234567890', { fetchImpl: f }), /grant.*失败/);
});

test('getBindings：HTTP 401 要抛错，不能吞成空列表（审查 H03）', async () => {
  const f = fakeFetch([[/binding/, () => okJson({ code: 401, message: 'expired' }, 401)]]);
  await assert.rejects(() => getBindings('c', 's', { fetchImpl: f }), /取绑定列表失败/);
});

test('getBindings：业务 code 非 0 要抛错', async () => {
  const f = fakeFetch([[/binding/, () => okJson({ code: 401, message: 'expired' }, 200)]]);
  await assert.rejects(() => getBindings('c', 's', { fetchImpl: f }), /取绑定列表失败/);
});

test('getBindings：真正的空列表是合法结果（不抛）', async () => {
  const f = fakeFetch([[/binding/, () => okJson({ code: 0, data: { list: [] } })]]);
  assert.deepEqual(await getBindings('c', 's', { fetchImpl: f }), []);
});

test('exchangeCred：一次性 code 失败不重试（审查 H04）', async () => {
  let n = 0;
  const f = async () => { n++; return okJson({ code: 500 }, 500); };
  await assert.rejects(() => exchangeCred('one-shot', { fetchImpl: f }));
  assert.equal(n, 1, '一次性 code 不能被提交两次，实际请求 ' + n + ' 次');
});

test('checkinRole：HTTP 500 不能当成成功（审查 H03）', async () => {
  const f = fakeFetch([[/attendance/, () => okJson({ code: 0 }, 500)]]);
  const r = await checkinRole({ uid: 'u', channelMasterId: 1 }, 'arknights', 'c', 's', { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.message, /结果未知|服务端错误/);
});

test('N04 core 不按编码形状拒绝 token，序列化原值发出', async () => {
  for (const token of ['short', 'aaaaaaaa.bbbbbbbb.cccccccc', 'has space in it', 'a":b', 'padded==', 'x\u0001y', '']) {
    let sent;
    assert.equal(await grantCode(token, { fetchImpl: async (_url, opt) => {
      sent = JSON.parse(opt.body).token;
      return okJson({ data: { code: 'FAKE_CODE' }, msg: 'OK', status: 0, type: 'A' });
    } }), 'FAKE_CODE');
    assert.equal(sent, token);
  }
});

test('N04 CLI/UI 输入校验只管类型、空值、长度和控制字符', () => {
  for (const token of ['short', 'a.b.c', 'a":b', 'padded==']) assert.equal(tokenInputError(token), '');
  for (const token of [null, { toString: 5 }, '', ' ', 'a\n', 'x'.repeat(4097)]) assert.ok(tokenInputError(token));
});

const SECRET = 'SYNTHETIC_SECRET_MARKER';
const cached = { cred: 'FAKE_C', signToken: 'FAKE_S' };
const role = { uid: 'u', channelMasterId: 1 };

test('H02 业务 message 和非数字 code 不进入 assertOk 错误', async () => {
  for (const code of [401, SECRET, { secret: SECRET }]) {
    await assert.rejects(getBindings('c', 's', { retries: 0, fetchImpl: async () => okJson({ code, message: SECRET }) }), (e) => {
      assert.equal(e.message.includes(SECRET), false);
      assert.match(e.message, /业务错误|响应结构错误/);
      return true;
    });
  }
});

test('H02 签到成功、已签和业务失败均只返回固定文案', async () => {
  for (const [code, message] of [[0, '签到成功'], [10001, '已经签过'], [403, '签到失败（业务错误）']]) {
    const out = await checkinRole(role, 'arknights', 'c', 's', { fetchImpl: async () => okJson({ code, message: SECRET }) });
    assert.equal(out.message, message);
    assert.equal(JSON.stringify(out).includes(SECRET), false);
  }
});

test('H02 角色 catch 不回显 e.message，网络失败不重放且继续下个角色', async () => {
  let attendanceCalls = 0;
  const f = async (url) => {
    if (url.includes('/binding')) return okJson({ code: 0, data: { list: [{ appCode: 'arknights', bindingList: [role, role] }] } });
    if (++attendanceCalls === 1) throw new Error(SECRET);
    return okJson({ code: 0 });
  };
  const { results } = await checkinToken('arbitrary', { cred: cached, fetchImpl: f, delayMs: 0 });
  assert.equal(results.length, 2);
  assert.match(results[0].message, /结果未知/);
  assert.equal(results[1].ok, true);
  assert.equal(JSON.stringify(results).includes(SECRET), false);
  assert.equal(attendanceCalls, 2);
});

test('H02 非 JSON 响应与任意异常对象只给安全类型', async () => {
  await assert.rejects(grantCode('t', { retries: 0, fetchImpl: async () => ({ status: 200, text: async () => SECRET }) }), (e) => !e.message.includes(SECRET));
  for (const e of [new Error(SECRET), new TypeError(SECRET), new SyntaxError(SECRET), SECRET, { message: SECRET, name: SECRET }]) {
    assert.equal(safeError(e).includes(SECRET), false);
  }
  const e = new CheckinError('BUSINESS', { operation: 'grant', code: 403 });
  e.message = SECRET;
  assert.equal(safeError(e), 'grant失败：业务错误 code=403');
});

test('H03 原反例 grant HTTP500+假 code 必须拒绝', async () => {
  await assert.rejects(grantCode('SYNTHETIC_TOKEN_12345', { retries: 0, fetchImpl: async () => okJson({ code: 403, data: { code: 'FAKE_CODE' } }, 500) }), /HTTP 500/);
});

test('H03 原反例 exchange HTTP401+假凭据必须拒绝', async () => {
  await assert.rejects(exchangeCred('FAKE_CODE', { fetchImpl: async () => okJson({ code: 403, data: { cred: 'FAKE_C', token: 'FAKE_S' } }, 401) }), /HTTP 401/);
});

test('H03 grant/exchange 拒绝 HTTP 非2xx、非0业务码及不完整结构', async () => {
  // ⚠️ 2026-10-21 实测修正：grant 的真实响应是 {data:{uid,code,token},msg,status,type} —— **没有顶层 code**，
  //   所以「缺顶层 code」对 grant 是正常的（它用 status 表示结果）；exchangeCred 才要求顶层 code。
  for (const status of [199, 302, 401, 500]) {
    await assert.rejects(grantCode('fake', { retries: 0, fetchImpl: async () => okJson({ data: { code: 'FAKE_CODE' } }, status) }));
    await assert.rejects(exchangeCred('fake', { retries: 0, fetchImpl: async () => okJson({ code: 0, data: { cred: 'c', token: 's' } }, status) }));
  }
  for (const json of [null, [], {}, { code: '0', data: { code: 'FAKE_CODE' } }, { code: 403, data: { code: 'FAKE_CODE' } }, { code: 10001, data: { code: 'FAKE_CODE' } }]) {
    await assert.rejects(grantCode('fake', { retries: 0, fetchImpl: async () => okJson(json) }));
  }
  // grant 缺顶层 code 但 data.code 正常 ⇒ **必须成功**（真接口就是这样）
  assert.equal(await grantCode('fake', { retries: 0, fetchImpl: async () => okJson({ data: { code: 'FAKE_CODE' }, msg: 'OK', status: 0, type: 'A' }) }), 'FAKE_CODE');
  // grant 的 status 非 0 ⇒ 业务错误
  await assert.rejects(grantCode('fake', { retries: 0, fetchImpl: async () => okJson({ data: { code: 'X' }, status: 7 }) }));
  for (const json of [null, [], {}, { data: { cred: 'c', token: 's' } }, { code: '0', data: { cred: 'c', token: 's' } }, { code: 403, data: { cred: 'c', token: 's' } }, { code: 10001, data: { cred: 'c', token: 's' } }, { code: 0 }]) {
    await assert.rejects(exchangeCred('fake', { retries: 0, fetchImpl: async () => okJson(json) }));
  }
  for (const data of [{ code: 123 }, { code: '' }]) await assert.rejects(grantCode('t', { fetchImpl: async () => okJson({ code: 0, data }) }));
  for (const data of [{ cred: 1, token: 's' }, { cred: 'c', token: {} }, { cred: '', token: 's' }, { cred: 'c', token: 's', userId: {} }]) {
    await assert.rejects(exchangeCred('t', { fetchImpl: async () => okJson({ code: 0, data }) }));
  }
});

test('H03 绑定不接受缺失code/10001，签到401+code0不能报成功', async () => {
  for (const json of [{ data: { list: [] } }, { code: 10001, data: { list: [] } }, { code: 0, data: { list: [null] } }]) {
    await assert.rejects(getBindings('c', 's', { fetchImpl: async () => okJson(json) }));
  }
  const out = await checkinRole(role, 'arknights', 'c', 's', { fetchImpl: async () => okJson({ code: 0 }, 401) });
  assert.equal(out.ok, false);
  assert.equal(out.already, false);
  assert.match(out.message, /HTTP 401/);
});

test('H04 opts.retries 无法重放兑换 code（JSON5xx/非JSON5xx/网络异常）', async () => {
  for (const retries of [1, 5]) for (const mode of ['json', 'text', 'network']) {
    const submitted = [];
    await assert.rejects(exchangeCred('FAKE_ONESHOT', { retries, fetchImpl: async (_url, opt) => {
      submitted.push(JSON.parse(opt.body).code);
      if (mode === 'network') throw new TypeError('fetch failed ' + SECRET);
      if (mode === 'text') return { status: 503, text: async () => SECRET };
      return okJson({ code: 503 }, 503);
    } }));
    assert.deepEqual(submitted, ['FAKE_ONESHOT']);
  }
});

test('H04 签到 opts.retries 同样不能覆盖不重放策略', async () => {
  let calls = 0;
  const out = await checkinRole(role, 'arknights', 'c', 's', { retries: 5, fetchImpl: async () => { calls++; return okJson({ code: 0 }, 503); } });
  assert.equal(out.ok, false);
  assert.equal(calls, 1);
});

test('N02 grant 默认503后可恢复，兑换仍仅提交一次新 code', async () => {
  let grants = 0, exchanges = 0;
  const f = async (url) => {
    if (url.includes('/grant')) return ++grants === 1 ? okJson({ code: 503 }, 503) : okJson({ data: { code: 'NEW_FAKE_CODE' }, msg: 'OK', status: 0, type: 'A' });
    exchanges++;
    return okJson({ code: 0, data: { cred: 'c', token: 's' } });
  };
  assert.equal(await grantCode('any', { fetchImpl: f }), 'NEW_FAKE_CODE');
  assert.equal((await exchangeCred('NEW_FAKE_CODE', { fetchImpl: f })).cred, 'c');
  assert.equal(grants, 2);
  assert.equal(exchanges, 1);
});

test('N02 非JSON503的绑定请求也可重试，业务失败不重试', async () => {
  let calls = 0;
  assert.deepEqual(await getBindings('c', 's', { fetchImpl: async () => ++calls === 1 ? { status: 503, text: async () => SECRET } : okJson({ code: 0, data: { list: [] } }) }), []);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(grantCode('t', { fetchImpl: async () => { calls++; return okJson({ code: 403 }); } }));
  assert.equal(calls, 1);
});

test('M04 原始反例与嵌套/转义字符串往返保真', () => {
  const values = ['a":b', 'a","b', '\\":,', '"', '\\', '\\\\":x', '\n\t\u0000', '中文🐟', ':,{}[]'];
  for (const x of values) {
    const original = { [x]: x, nested: [x, { x, n: null, bool: true, number: 12 }], omitted: undefined };
    assert.deepEqual(JSON.parse(pyJson(original)), JSON.parse(JSON.stringify(original)));
  }
  assert.equal(JSON.parse(pyJson({ x: 'a"\u003ab' })).x, 'a":b');
  assert.equal(pyJson(['a', 'b']), '["a","b"]');
  assert.equal(pyJson({ x: 'a":b', y: [1, 2] }), '{"x": "a\\\":b","y": [1,2]}');
});

test('M04 扫描器保留 JSON.stringify 的 toJSON/undefined/循环/BigInt 语义', () => {
  assert.equal(pyJson(undefined), undefined);
  assert.equal(pyJson({ toJSON: () => ({ x: 'a":b' }) }), pyJson({ x: 'a":b' }));
  assert.deepEqual(JSON.parse(pyJson([undefined, NaN, Infinity])), [null, null, null]);
  const circle = {}; circle.self = circle;
  assert.throws(() => pyJson(circle), TypeError);
  assert.throws(() => pyJson(1n), TypeError);
});

test('M04 固定时间签名向量与实际 POST body 相同', async (t) => {
  t.mock.method(Date, 'now', () => 1700000002000);
  const expectedBody = '{"uid": "u1","gameId": 1}';
  const expectedSign = 'bfe3af6ae8f10fb1e0cfb7360162b1be';
  const h = signHeaders('fixed-sign-token', '/api/v1/game/attendance', expectedBody);
  assert.equal(h.timestamp, '1700000000');
  assert.equal(h.sign, expectedSign);
  let sent;
  await checkinRole({ uid: 'u1', channelMasterId: 1 }, 'arknights', 'c', 'fixed-sign-token', { fetchImpl: async (_url, opt) => { sent = opt; return okJson({ code: 0 }); } });
  assert.equal(sent.body, expectedBody);
  assert.equal(sent.headers.sign, expectedSign);
});

test('M04 上游 uid/roleId/serverId 内的引号和分隔符不改值', async () => {
  const original = { uid: 'u":x', defaultRole: { roleId: 'r","x', serverId: 's\\":x' } };
  await checkinRole(original, 'endfield', 'c', 's', { fetchImpl: async (_url, opt) => {
    assert.deepEqual(JSON.parse(opt.body), { uid: original.uid, gameId: 3, roleId: original.defaultRole.roleId, serverId: original.defaultRole.serverId });
    return okJson({ code: 0 });
  } });
});

test('CLI/server/notify 离线边界回归（内存替身，禁止真实监听/文件缓存/网络）', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // 子测试必须独立启动，不能继承父 runner 的内部协议。
  const out = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', '--test-reporter=tap', 'test/boundaries.test.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(out.status, 0, (out.stderr || '') + (out.stdout || ''));
  assert.match(out.stdout, /# tests 10\b/);
  assert.match(out.stdout, /# pass 10\b/);
});

test('终审：grant 缺 status 或 code:0 配 status:7 都要拒', async () => {
  // 缺 status：不能当成功
  await assert.rejects(grantCode('fake', { retries: 0, fetchImpl: async () => okJson({ data: { code: 'X' } }) }), /grant/);
  // code:0 但 status:7：assertOk 会因 code===0 提前返回，必须由额外校验兜住
  await assert.rejects(grantCode('fake', { retries: 0, fetchImpl: async () => okJson({ data: { code: 'X' }, code: 0, status: 7 }) }), /grant/);
  // 真实结构必须成功
  assert.equal(await grantCode('fake', { retries: 0, fetchImpl: async () => okJson({ data: { uid: 'u', code: 'OK_CODE', token: 't' }, msg: 'OK', status: 0, type: 'A' }) }), 'OK_CODE');
});

test('终审：凭据缓存损坏要报错并留备份，不能静默当空库', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { CredStore } = await import('../src/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skland-store-'));
  const store = new CredStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds.json'), '{ 这不是合法 JSON', 'utf8');
  assert.throws(() => store.get('some-token'), /损坏/);
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(backups.length, 1, '应留下一个 .corrupt-* 备份，实际 ' + JSON.stringify(backups));
  // 没损坏时正常
  const store2 = new CredStore({ dir });
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ version: 1, accounts: {} }), 'utf8');
  assert.equal(store2.get('some-token'), null);
});

test('四审：accounts 是数组（结构不对）要报错，不能静默写坏', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { CredStore } = await import('../src/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skland-store2-'));
  const store = new CredStore({ dir });
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ version: 1, accounts: [] }), 'utf8');
  assert.throws(() => store.get('some-token'), /结构不对/);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), '应留备份');
  // 缺 accounts 字段也一样
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ version: 1 }), 'utf8');
  assert.throws(() => store.get('some-token'), /结构不对/);
});

test('M01：同一缓存目录第二个锁要报 Busy，释放后可再拿', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { acquireLock, BusyError } = await import('../src/lock.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skland-lock-'));
  const release = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), BusyError);
  release();
  const release2 = await acquireLock(dir);
  release2();
});

test('M02：缓存 version 不支持 / 条目字段坏要拒并保留原文件', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { CredStore } = await import('../src/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skland-schema-'));
  const f = path.join(dir, 'creds.json');
  fs.writeFileSync(f, JSON.stringify({ version: 999, accounts: {} }), 'utf8');
  assert.throws(() => new CredStore({ dir }).get('t'), /版本/);
  fs.writeFileSync(f, JSON.stringify({ version: 1, accounts: { abc: { cred: {}, signToken: [] } } }), 'utf8');
  assert.throws(() => new CredStore({ dir }).get('t'), /条目/);
});

test('M04：grant data.code 缺失或非字符串要拒（补假绿）', async () => {
  await assert.rejects(grantCode('fake', { retries: 0, fetchImpl: async () => okJson({ data: {}, status: 0 }) }), /grant/);
  await assert.rejects(grantCode('fake', { retries: 0, fetchImpl: async () => okJson({ data: { code: 123 }, status: 0 }) }), /grant/);
  await assert.rejects(grantCode('fake', { retries: 0, fetchImpl: async () => okJson({ data: { code: '' }, status: 0 }) }), /grant/);
});
