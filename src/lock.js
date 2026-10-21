// 单实例互斥：同一个缓存目录只允许一个进程读改写凭据缓存（审查 M01）。
// 设计：用 wx 创建锁文件，拿到后写入唯一 id；**不做自动接管**（接管存在 TOCTOU 竞态），
// 锁已存在时给出可操作的错误，由用户确认后手动删除。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class BusyError extends Error {
  constructor(message = '另一个签到实例正在运行') { super(message); this.name = 'BusyError'; }
}

const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
};

/** 拿锁；返回 release（幂等，只删自己 id 的锁）。拿不到抛 BusyError。 */
export async function acquireLock(dir) {
  const file = path.join(dir, '.lock');
  const mine = crypto.randomUUID();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), id: mine })); }
    finally { fs.closeSync(fd); }
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let info = null;
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 空/坏锁 */ }
    const pid = info && Number.isSafeInteger(info.pid) ? info.pid : null;
    if (pid && alive(pid)) throw new BusyError('另一个签到实例正在运行（pid ' + pid + '），等它结束再试');
    if (pid) throw new BusyError('发现上次运行留下的锁（持有进程已退出）。确认没有其它签到在跑后，删除 ' + file + ' 再重试');
    throw new BusyError('锁文件状态无法确认（可能上次运行异常退出）。确认没有其它签到在跑后，删除 ' + file + ' 再重试');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    let cur;
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    if (!cur || cur.id !== mine) return;   // 不是自己的（或已被替换），不删
    try { fs.unlinkSync(file); } catch { /* 已被清理 */ }
  };
}
