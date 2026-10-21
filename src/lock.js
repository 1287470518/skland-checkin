// 单实例互斥：同一个缓存目录只允许一个进程读改写凭据缓存（审查 M01）。
import fs from 'node:fs';
import path from 'node:path';

export class BusyError extends Error {
  constructor(message = '另一个签到实例正在运行') { super(message); this.name = 'BusyError'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
};

/**
 * 拿锁；返回 release。
 * - 只在「持有者进程已死」或「坏锁且文件很旧」时接管，绝不因为超时就抢活着的锁；
 * - 刚创建还没写完的空锁有 initMs 的初始化窗口，不会误删；
 * - release 只删自己 pid 的锁，避免旧进程删掉新持有者的锁。
 */
export async function acquireLock(dir, { waitMs = 3000, initMs = 2000 } = {}) {
  const file = path.join(dir, '.lock');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); }
      finally { fs.closeSync(fd); }
      return () => {
        try {
          const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (cur.pid !== process.pid) return;   // 不是自己的锁，别删
        } catch { return; }                       // 读不出/不存在，不删
        try { fs.unlinkSync(file); } catch { /* 已被清理 */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info = null, mtime = 0;
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 空/坏锁 */ }
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      const live = info && Number.isSafeInteger(info.pid) && alive(info.pid);
      if (live) throw new BusyError();
      if (!info && Date.now() - mtime < initMs) {
        // 可能是别的进程刚创建、还没写完内容：等一会再判断
        if (Date.now() > deadline) throw new BusyError();
        await sleep(50);
        continue;
      }
      try { fs.unlinkSync(file); } catch { /* 竞争删除，下一轮再试 */ }
    }
  }
}
