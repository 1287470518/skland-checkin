#!/usr/bin/env node
// skland-checkin CLI —— 森空岛（明日方舟 / 终末地）自动签到
// 零依赖，Node 18+
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { checkinToken } from './core.js';
import { CredStore } from './store.js';
import { makeNotifier } from './notify.js';
import { acquireLock, BusyError } from './lock.js';
import { safeError, safeCacheError } from './errors.js';
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
    else if (k === '--install-task') {
      // 可选带一个时间参数；不带就默认 08:00
      a.installTask = (argv[i + 1] && !/^--?/.test(argv[i + 1])) ? argv[++i] : '08:00';
    }
    else if (k === '--uninstall-task') a.uninstallTask = true;
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
    '  --install-task [HH:MM]  设置 Windows 每天自动签到（默认 08:00）',
    '  --uninstall-task        取消每天自动签到',
    '  --help / --version 帮助 / 版本',
    '退出码：0=角色成功/已签或没有绑定角色；1=账号/角色失败；2=参数或输入格式错误',
    'Node.js >=18；token 不限制 Base64/JWT 形状，仅校验类型、长度和控制字符',
    '',
    'token 怎么拿：浏览器登录 https://www.skland.com/ → 打开 https://web-api.skland.com/account/info/hg',
    '              复制返回里 data.content 那一串（这是登录凭证，别外传）',
  ].join('\n'));
}

/** 任务名由包目录派生：不同目录各自独立，同目录重设只覆盖自己（审查 B2：不做归属解析）。 */
function dailyTaskName(cliPath) {
  const dir = path.dirname(path.dirname(cliPath));
  return 'SklandCheckin_' + crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 8);
}

/** 设置 Windows 任务计划：每天固定时间跑一次签到。 */
function setupDailyTask(time) {
  time = String(time || '').trim();
  if (process.platform !== 'win32') { console.error('这个参数只支持 Windows；Linux/macOS 请用 cron'); process.exit(2); }
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) { console.error('时间格式不对，例如 08:00'); process.exit(2); }
  if (!/^node(\.exe)?$/i.test(path.basename(process.execPath))) { console.error('请用 node.exe 运行这条命令（--install-task 需要 Node 自己的路径）'); process.exit(2); }
  const cli = fileURLToPath(import.meta.url);
  const tokens = path.join(path.dirname(cli), '..', 'tokens.txt');
  if (!fs.existsSync(tokens)) { console.error('没有找到 tokens.txt：' + tokens + '（先在包目录里双击「一键签到」配置一次）'); process.exit(2); }
  const task = dailyTaskName(cli);
  const tr = '"' + process.execPath + '" "' + cli + '" --token-file "' + tokens + '"';
  try {
    execFileSync('schtasks', ['/create', '/f', '/tn', task, '/tr', tr, '/sc', 'daily', '/st', time], { stdio: 'inherit' });
  } catch {
    console.error('创建任务失败：请右键「设置每天自动签到.bat」，选「以管理员身份运行」再试。');
    process.exit(1);
  }
  console.log('已设置：每天 ' + time + ' 自动签到（任务 ' + task + '；电脑开机且这个用户已登录时运行）。取消：--uninstall-task');
  process.exit(0);
}

function removeDailyTask() {
  if (process.platform !== 'win32') { console.error('这个参数只支持 Windows'); process.exit(2); }
  const cli = fileURLToPath(import.meta.url);
  const task = dailyTaskName(cli);
  try { execFileSync('schtasks', ['/delete', '/f', '/tn', task], { stdio: 'inherit' }); }
  catch { console.error('没有找到本包的自动签到任务（' + task + '），可能已经取消或从别的目录设置过。'); process.exit(1); }
  console.log('已取消每天自动签到（任务 ' + task + '）。');
  process.exit(0);
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
  if (a.installTask) return setupDailyTask(a.installTask);
  if (a.uninstallTask) return removeDailyTask();

  const accounts = [];
  if (a.token) accounts.push({ name: '', token: a.token });
  if (a.tokenFile) {
    try { accounts.push(...readTokenFile(a.tokenFile)); }
    catch { console.error('token 文件无法读取或格式不对（--help 看用法）'); process.exit(2); }
  }
  if (!accounts.length) { usage(); process.exit(2); }
  if (accounts.some((acc) => tokenInputError(acc.token))) { console.error('token 输入不合法（须为非空字符串、最多 4096 字符、不含控制字符）'); process.exit(2); }

  const store = new CredStore();
  // 单实例互斥：同一个缓存目录只允许一个签到进程（审查 M01）
  let release;
  try { release = await acquireLock(store.dir); }
  catch (e) {
    console.error('❌ ' + (e instanceof BusyError ? e.message : '无法创建运行锁'));
    process.exit(1);
  }
  if (typeof process.on === 'function') process.on('exit', release);
  // 通知配置在开始签到前校验：配错了就别先签到再报错（审查 L06）
  const NOTIFY_TYPES = ['none', 'stdout', 'webhook', 'bark', 'serverchan'];
  if (!NOTIFY_TYPES.includes(a.notify)) {
    console.error('❌ 未知通知方式：' + a.notify + '（可选：' + NOTIFY_TYPES.join(' / ') + '）');
    process.exit(2);
  }
  if ((a.notify === 'webhook' || a.notify === 'bark') && !a.notifyUrl) {
    console.error('❌ --notify ' + a.notify + ' 需要 --notify-url');
    process.exit(2);
  }
  if (a.notify === 'serverchan' && !a.notifyKey && !process.env.SERVERCHAN_KEY) {
    console.error('❌ --notify serverchan 需要 --notify-key 或 SERVERCHAN_KEY');
    process.exit(2);
  }
  const notify = makeNotifier(a.notify, { url: a.notifyUrl, key: a.notifyKey, template: a.notifyTemplate });
  const all = [];
  const lines = [];

  const accountErrors = [];
  const cacheWarnings = [];
  for (const [accountIndex, acc] of accounts.entries()) {
    const label = acc.name || '账号';
    // 账号级错误隔离：一个号失败不影响后面的号（审查 M05）
    try {
      let cred = a.cache ? store.get(acc.token) : null;
      const { cred: usedCred, results } = await checkinToken(acc.token, { cred });
      // ⚠️ 先保住签到结果，再尝试写缓存；缓存写失败只记警告，不把已经签到的结果丢掉（审查 M03）
      // 每条结果带上账号索引，多账号时 JSON/通知 raw 能反向对应到账号（审查 L05）
      all.push(...results.map((r) => ({ ...r, accountIndex })));
      if (!cred) {
        try { store.put(acc.token, usedCred); }
        catch { cacheWarnings.push({ accountIndex, name: label, message: safeCacheError() }); }
      }
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
  const raw = { summary: s, results: all, accountErrors, ...(cacheWarnings.length ? { cacheWarnings } : {}) };
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
