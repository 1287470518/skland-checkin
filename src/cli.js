#!/usr/bin/env node
// skland-checkin CLI —— 森空岛（明日方舟 / 终末地）自动签到
// 零依赖，Node 18+
import fs from 'node:fs';
import { checkinToken } from './core.js';
import { CredStore } from './store.js';
import { makeNotifier } from './notify.js';
import { safeError } from './errors.js';
import { tokenInputError } from './input.js';

function parseArgs(argv) {
  const a = { notify: 'none', cache: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      if (argv[i + 1] === undefined || /^--?/.test(argv[i + 1])) {
        a.error = '参数缺值：' + k;
        return undefined;
      }
      return argv[++i];
    };
    if (k === '--token') a.token = next();
    else if (k === '--token-file') a.tokenFile = next();
    else if (k === '--notify') a.notify = next();
    else if (k === '--notify-url') a.notifyUrl = next();
    else if (k === '--notify-key') a.notifyKey = next();
    else if (k === '--notify-template') a.notifyTemplate = next();
    else if (k === '--no-cache') a.cache = false;
    else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--version' || k === '-v') a.version = true;
    else if (!a.unknown) a.unknown = true;
  }
  return a;
}

function usage() {
  console.log([
    'skland-checkin —— 森空岛自动签到（明日方舟 / 终末地）',
    '',
    '用法：',
    '  skland-checkin --token <token>                     # 单个账号',
    '  skland-checkin --token-file tokens.txt             # 一行一个 token，或 JSON 对象 {"name":"账号A","token":"..."}',
    '  skland-checkin --token <token> --notify webhook --notify-url <url>',
    '  skland-checkin --token <token> --notify bark --notify-url https://api.day.app/<key>',
    '',
    '选项：',
    '  --no-cache          忽略本地缓存，强制重新换凭据',
    '  --json              输出 summary / results / accountErrors；通知 raw 使用相同结构',
    '  --notify <type>     none（默认）/ stdout / webhook / bark / serverchan',
    '  --notify-url <url>  webhook / bark 的目标地址',
    '  --notify-key <key>  serverchan 的 SendKey（也可设 SERVERCHAN_KEY）',
    '  --notify-template <text>  webhook 改发 {text}',
    '  --help / --version 帮助 / 版本',
    '退出码：0=角色成功/已签或没有绑定角色；1=账号/角色失败；2=参数或输入格式错误',
    'Node.js >=18；token 不限制 Base64/JWT 形状，仅校验类型、长度和控制字符',
    '',
    'token 怎么拿：浏览器登录 https://www.skland.com/ → 打开 https://web-api.skland.com/account/info/hg',
    '              复制返回里 data.content 那一串（这是登录凭证，别外传）',
  ].join('\n'));
}

function readTokenFile(p) {
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      if (!l.startsWith('{')) return { name: '', token: l };
      const item = JSON.parse(l);
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.token !== 'string' ||
          (item.name !== undefined && typeof item.name !== 'string')) throw new TypeError();
      return { name: item.name || '', token: item.token };
    });
}

function summarize(results) {
  const ok = results.filter((r) => r.ok).length;
  const already = results.filter((r) => r.already).length;
  const bad = results.filter((r) => !r.ok && !r.already);
  return { ok, already, bad: bad.length, total: results.length, badList: bad };
}

const main = async () => {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) { console.error(a.error); process.exit(2); }
  if (a.help) return usage();
  if (a.version) return console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  if (a.unknown) { console.error('不认识的参数（--help 看用法）'); process.exit(2); }

  const accounts = [];
  if (a.token) accounts.push({ name: '', token: a.token });
  if (a.tokenFile) {
    try { accounts.push(...readTokenFile(a.tokenFile)); }
    catch { console.error('token 文件无法读取或格式不对（--help 看用法）'); process.exit(2); }
  }
  if (!accounts.length) { usage(); process.exit(2); }
  if (accounts.some((acc) => tokenInputError(acc.token))) { console.error('token 输入不合法（须为非空字符串、最多 4096 字符、不含控制字符）'); process.exit(2); }

  const store = new CredStore();
  const notify = makeNotifier(a.notify, { url: a.notifyUrl, key: a.notifyKey, template: a.notifyTemplate });
  const all = [];
  const lines = [];

  const accountErrors = [];
  for (const [accountIndex, acc] of accounts.entries()) {
    const label = acc.name || '账号';
    // 账号级错误隔离：一个号失败不影响后面的号（审查 M05）
    try {
      let cred = a.cache ? store.get(acc.token) : null;
      const { cred: usedCred, results } = await checkinToken(acc.token, { cred });
      if (!cred) store.put(acc.token, usedCred);
      all.push(...results);
      if (!results.length) lines.push(label + ' → 没有绑定角色');
      for (const r of results) {
        const state = r.ok ? '✅ 签到成功' + (r.awards.length ? '（' + r.awards.join('、') + '）' : '')
          : r.already ? '已经签过' : '⚠️ ' + (r.message || '失败');
        lines.push(label + ' · ' + r.appCode + ' · ' + r.label + ' → ' + state);
      }
    } catch (e) {
      const message = safeError(e);
      accountErrors.push({ accountIndex, name: label, message });
      lines.push(label + ' → ⚠️ 整号失败：' + message);
    }
  }

  const s = summarize(all);
  s.accountErrors = accountErrors.length;
  const raw = { summary: s, results: all, accountErrors };
  const text = lines.join('\n') + '\n\n成功 ' + s.ok + ' · 已签 ' + s.already + ' · 失败 ' + s.bad + '（共 ' + s.total + '） · 整号失败 ' + accountErrors.length;
  if (a.json) console.log(JSON.stringify(raw, null, 2));
  else console.log(text);
  // 通知失败**不改变**签到结果的退出码：否则定时任务会把「推送挂了」误判成「签到失败」而重跑（审查 M05）
  try { await notify({ title: '森空岛签到', text, raw }); }
  catch (e) { console.error('⚠️ 通知发送失败（不影响签到结果）：' + safeError(e)); }
  if (s.bad > 0 || accountErrors.length > 0) process.exit(1);
  process.exit(0);
};

main().catch((e) => { console.error('❌ ' + safeError(e)); process.exit(1); });
