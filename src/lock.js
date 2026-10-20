// 单实例互斥：同一个缓存目录只允许一个进程读改写凭据缓存（审查 M01）。
import fs from 'node:fs';
import path from 'node:path';

export class BusyError extends Error {
  constructor(message = '另一个签到实例正在运行') { super(message); this.name = 'BusyError'; }
}

const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
};

/** 拿锁；返回 release。拿不到抛 BusyError（进程停死/锁过期时自动接管）。 */
export function acquireLock(dir, { staleMs = 30 * 60 * 1000 } = {}) {
  const file = path.join(dir, '.lock');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.unlinkSync(file); } catch { /* 已被清理 */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info = null;
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 坏锁按可接管处理 */ }
      const dead = !info || !Number.isSafeInteger(info.pid) || !alive(info.pid)
        || Date.now() - (info.at || 0) > staleMs;
      if (dead) {
        try { fs.unlinkSync(file); } catch { /* 别的进程也在抢，下一轮再试 */ }
        continue;
      }
      throw new BusyError();
    }
  }
  throw new BusyError();
}
