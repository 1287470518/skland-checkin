// Windows 任务计划：每天固定时间跑 daily.mjs。任务名按包目录派生，互不覆盖。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';

export function taskNameFor(dir) {
  return 'SklandCheckin_' + crypto.createHash('sha1').update(String(dir).toLowerCase()).digest('hex').slice(0, 8);
}

export function installDailyTask({ cliPath, tokensPath, time = '00:10' }) {
  if (process.platform !== 'win32') throw new Error('只支持 Windows');
  const node = process.execPath;
  const task = taskNameFor(path.dirname(path.dirname(cliPath)));
  const tr = '"' + node + '" "' + cliPath + '" --token-file "' + tokensPath + '"';
  execFileSync('schtasks', ['/create', '/f', '/tn', task, '/tr', tr, '/sc', 'daily', '/st', time], { stdio: 'ignore' });
  return task;
}

export function removeDailyTask(cliPath) {
  if (process.platform !== 'win32') throw new Error('只支持 Windows');
  const task = taskNameFor(path.dirname(path.dirname(cliPath)));
  execFileSync('schtasks', ['/delete', '/f', '/tn', task], { stdio: 'ignore' });
  return task;
}

/** 开机（登录时）自启：静默跑一次 daily，不弹窗口。 */
export function installBootTask({ cliPath, tokensPath }) {
  if (process.platform !== 'win32') throw new Error('只支持 Windows');
  const task = taskNameFor(path.dirname(path.dirname(cliPath))) + '_boot';
  const tr = '"' + process.execPath + '" "' + cliPath + '" --token-file "' + tokensPath + '"';
  execFileSync('schtasks', ['/create', '/f', '/tn', task, '/tr', tr, '/sc', 'onlogon'], { stdio: 'ignore' });
  return task;
}

export function removeBootTask(cliPath) {
  if (process.platform !== 'win32') throw new Error('只支持 Windows');
  const task = taskNameFor(path.dirname(path.dirname(cliPath))) + '_boot';
  execFileSync('schtasks', ['/delete', '/f', '/tn', task], { stdio: 'ignore' });
  return task;
}

export function bootTaskInstalled(cliPath) {
  if (process.platform !== 'win32') return false;
  const task = taskNameFor(path.dirname(path.dirname(cliPath))) + '_boot';
  try { execFileSync('schtasks', ['/query', '/tn', task], { stdio: 'ignore' }); return true; } catch { return false; }
}
