// 真实 ESM 源码 + 内存导入替身；不调用真实 fetch、fs 凭据读写或 http.listen。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET = 'SYNTHETIC_SECRET_MARKER';
const root = fileURLToPath(new URL('../', import.meta.url));
class ExitSignal { constructor(code) { this.code = code; } }
const result = { cred: { cred: 'FAKE_C', signToken: 'FAKE_S' }, results: [] };

async function sandbox(entry, { checkin = async () => result, tokenFile = '', storeGet = () => null, fetchImpl, argv = [] } = {}) {
  const logs = [], errors = [], notifications = [], seen = [];
  let listener, listenCalls = 0, storeCalls = 0;
  const fakeFs = {
    readFileSync(p) {
      // fs 只在内存中提供合成数据；不访问传入的真实文件路径。
      if (String(p).endsWith('index.html')) return Buffer.from('<html>FAKE</html>');
      return tokenFile;
    },
  };
  class Store {
    get(token) { storeCalls++; return storeGet(token); }
    put() {}
  }
  const fakeProcess = {
    argv: ['node', entry, ...argv], env: {}, pid: 1,
    exit(code) { throw new ExitSignal(code); },
  };
  const context = vm.createContext({
    Buffer, URL, AbortSignal, setTimeout, clearTimeout,
    process: fakeProcess,
    fetch: fetchImpl || (() => { throw new Error('REAL_NETWORK_FORBIDDEN'); }),
    console: { log: (...x) => logs.push(x.join(' ')), error: (...x) => errors.push(x.join(' ')) },
  });
  const replacements = {
    'node:fs': { default: fakeFs },
    'node:http': { default: { createServer(fn) {
      listener = fn;
      return { on() {}, listen() { listenCalls++; } }; // 仅记录，绝不调用真实 listen。
    } } },
    'node:path': { default: path },
    'node:url': { fileURLToPath },
    'node:crypto': { default: crypto },
    './store.js': { CredStore: Store },
    './core.js': { checkinToken: async (token, opts) => { seen.push(token); return checkin(token, opts); } },
    './lock.js': { acquireLock: () => () => {}, BusyError: class BusyError extends Error {} },
  };
  if (entry === 'cli.js') replacements['./notify.js'] = { makeNotifier: () => async (msg) => { notifications.push(msg); } };
  const cache = new Map();
  async function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    assert.ok(['cli.js', 'server.js', 'notify.js', 'errors.js', 'input.js'].includes(filename));
    let source = fs.readFileSync(path.join(root, 'src', filename), 'utf8');
    if (filename === 'cli.js') {
      // 只移除启动入口，导出原 main；参数解析、业务循环和错误处理仍为原源码。
      const start = source.indexOf('\nmain().catch(');
      assert.ok(start > 0);
      source = source.slice(0, start) + '\nexport { main };\n';
    }
    const mod = new vm.SourceTextModule(source, {
      context, identifier: new URL('../src/' + filename, import.meta.url).href,
      initializeImportMeta(meta) { meta.url = new URL('../src/' + filename, import.meta.url).href; },
    });
    cache.set(filename, mod);
    await mod.link(async (specifier) => {
      if (replacements[specifier]) {
        const obj = replacements[specifier];
        return new vm.SyntheticModule(Object.keys(obj), function () {
          for (const [k, value] of Object.entries(obj)) this.setExport(k, value);
        }, { context });
      }
      assert.ok(['./errors.js', './input.js'].includes(specifier), '禁止未列出的导入 ' + specifier);
      return load(specifier.slice(2));
    });
    return mod;
  }
  const mod = await load(entry);
  await mod.evaluate();
  return {
    logs, errors, seen, notifications,
    get listenCalls() { return listenCalls; },
    get storeCalls() { return storeCalls; },
    async cli() {
      try { await mod.namespace.main(); return 0; }
      catch (e) { if (e instanceof ExitSignal) return e.code; throw e; }
    },
    module: mod.namespace,
    request(body, { method = 'POST', url = '/api/checkin', headers = { host: '127.0.0.1:8977', origin: 'http://127.0.0.1:8977' } } = {}) {
      const req = new EventEmitter();
      Object.assign(req, { method, url, headers });
      let complete;
      const done = new Promise((resolve) => { complete = resolve; });
      const res = {
        headersSent: false,
        writeHead(status) { this.status = status; this.headersSent = true; },
        end(value) { complete({ status: this.status, text: String(value), json: () => JSON.parse(String(value)) }); },
      };
      listener(req, res);
      queueMicrotask(() => {
        req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
        req.emit('end');
      });
      return done;
    },
  };
}

test('N01 原首尾碰撞 token 可并行；同完整 token 返回429，结束后可重试', async () => {
  const pending = [];
  const s = await sandbox('server.js', { checkin: (token) => new Promise((resolve) => pending.push({ token, resolve })) });
  const a = s.request({ token: 'AAAA11111111ZZZZ' });
  const b = s.request({ token: 'AAAA22222222ZZZZ' });
  const duplicate = await s.request({ token: 'AAAA11111111ZZZZ' });
  assert.equal(duplicate.status, 429);
  assert.deepEqual(s.seen, ['AAAA11111111ZZZZ', 'AAAA22222222ZZZZ']);
  for (const p of pending) p.resolve(result);
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
  const again = s.request({ token: 'AAAA11111111ZZZZ' });
  await new Promise((resolve) => setImmediate(resolve));
  pending.at(-1).resolve(result);
  assert.equal((await again).status, 200);
  assert.equal(s.listenCalls, 1, '只经过假监听入口');
});

test('H02 server 缓存异常不回显合成秘密；失败后inflight清除', async () => {
  let fail = true;
  const s = await sandbox('server.js', { storeGet: () => { if (fail) throw new Error(SECRET); return null; } });
  const first = await s.request({ token: 'synthetic' });
  assert.equal(first.status, 502);
  assert.equal(first.text.includes(SECRET), false);
  fail = false;
  assert.equal((await s.request({ token: 'synthetic' })).status, 200);
});

test('N04/N05 token对象的旧反例现在400；真正顶层异常记录安全分类和关联号', async () => {
  const s = await sandbox('server.js');
  const invalid = await s.request({ token: { toString: 5, marker: SECRET } });
  assert.equal(invalid.status, 400);
  assert.equal(s.seen.length, 0);
  assert.equal(s.errors.length, 0);
  const unexpected = await s.request({}, { headers: null }); // 原 handle 内部抛 TypeError。
  assert.equal(unexpected.status, 500);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /\[request-error [0-9a-f-]{36}\] 类型错误/);
  assert.equal(s.errors[0].includes(SECRET), false);
  assert.equal(unexpected.text.includes('TypeError'), false);
  assert.deepEqual(unexpected.json(), { error: '服务器内部错误' });
});

test('server 保留 null/畸形URL/超限/跨站/GET写入口防线', async () => {
  const s = await sandbox('server.js');
  assert.equal((await s.request('null')).status, 400);
  assert.equal((await s.request({}, { url: 'http://[' })).status, 400);
  assert.equal((await s.request('x'.repeat(8193))).status, 413);
  assert.equal((await s.request({}, { headers: { host: '127.0.0.1:8977', origin: 'http://evil.test' } })).status, 403);
  assert.equal((await s.request({}, { headers: { host: '127.0.0.1:8977' } })).status, 403);
  assert.equal((await s.request({}, { method: 'GET' })).status, 404);
  assert.equal((await s.request({ token: 'short' }, { headers: { host: '127.0.0.1:8977', 'x-skland-checkin': '1' } })).status, 200);
});

test('N03 CLI 唯一账号失败必须进入 JSON 和通知 raw，且退出1', async () => {
  const s = await sandbox('cli.js', { argv: ['--token', 'FAKE_TOKEN', '--json'], checkin: async () => { throw new Error(SECRET); } });
  assert.equal(await s.cli(), 1);
  const out = JSON.parse(s.logs[0]);
  assert.equal(out.summary.accountErrors, 1);
  assert.equal(out.summary.total, 0);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.accountErrors, [{ accountIndex: 0, name: '账号', message: '操作失败' }]);
  assert.equal(JSON.stringify(s.notifications[0].raw), JSON.stringify(out));
  assert.equal(JSON.stringify([s.logs, s.errors, s.notifications]).includes(SECRET), false);
});

test('N03 CLI 混合批次继续执行，角色和账号失败分开计数', async () => {
  const s = await sandbox('cli.js', {
    argv: ['--token-file', 'SYNTHETIC_INPUT_ONLY', '--json'],
    tokenFile: '{"name":"失败账号","token":"FAIL"}\n{"name":"成功账号","token":"OK"}',
    checkin: async (token) => {
      if (token === 'FAIL') throw new Error(SECRET);
      return { ...result, results: [{ appCode: 'arknights', label: '示例', ok: true, already: false, awards: [], message: '签到成功' }] };
    },
  });
  assert.equal(await s.cli(), 1);
  const out = JSON.parse(s.logs[0]);
  assert.deepEqual(s.seen, ['FAIL', 'OK']);
  assert.equal(out.summary.total, 1);
  assert.equal(out.summary.ok, 1);
  assert.equal(out.summary.bad, 0);
  assert.equal(out.summary.accountErrors, 1);
  assert.equal(out.accountErrors[0].name, '失败账号');
});

test('L01 token-file 不拆填充等号；JSON对象支持名称和任意 token 字符', async () => {
  const s = await sandbox('cli.js', {
    argv: ['--token-file', 'SYNTHETIC_INPUT_ONLY'],
    tokenFile: '# 注释\nabc==\n{"name":"示例","token":"a=b.c\\\":d"}\n',
  });
  assert.equal(await s.cli(), 0);
  assert.deepEqual(s.seen, ['abc==', 'a=b.c":d']);
  assert.match(s.logs[0], /没有绑定角色/);
});

test('L01 --help 默认none；缺值/未知参数/不合法输入退出2且不运行账号', async () => {
  const help = await sandbox('cli.js', { argv: ['--help'] });
  assert.equal(await help.cli(), 0);
  assert.match(help.logs[0], /none（默认）/);
  assert.match(help.logs[0], /退出码：0=/);
  for (const argv of [['--token'], ['--token', '--json'], ['--notify', '-h'], ['--unknown', SECRET], ['--token', 'x\n'], ['--token', 'x'.repeat(4097)]]) {
    const s = await sandbox('cli.js', { argv });
    assert.equal(await s.cli(), 2);
    assert.equal(s.seen.length, 0);
    assert.equal(JSON.stringify(s.errors).includes(SECRET), false);
  }
});

test('H02 通知错误不读取/回显服务端响应体', async () => {
  for (const type of ['webhook', 'serverchan', 'bark']) {
    let read = 0;
    const s = await sandbox('notify.js', { fetchImpl: async () => ({ status: 500, text: async () => { read++; return SECRET; } }) });
    await assert.rejects(s.module.makeNotifier(type, { url: 'https://example.invalid/FAKE', key: 'FAKE' })({ title: 'title', text: 'text', raw: {} }), (e) => {
      assert.equal(e.message.includes(SECRET), false);
      assert.match(e.message, /HTTP 状态错误/);
      return true;
    });
    assert.equal(read, 0);
  }
});

test('L01 发布选择和ignore覆盖搜狗残留；H01页面保持textContent', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const rule of ['%SystemDrive%/', 'ProgramData/', '*.bin', '**/sgim_picface_cloud.bin', '**/sgim_picface_cloud_bak.bin']) assert.ok(ignore.includes(rule));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.files, ['src', 'public', 'LICENSE']);
  assert.equal(pkg.engines.node, '>=18');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(html).digest('hex'), 'd214d086f1e220ba82eb3016c3cc3f922d1c5c230765c030cc0504c05b6e0965');
});
