// 单实例互斥：同一个缓存目录只允许一个进程读改写凭据缓存（审查 M01）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
 * - 只在持有者进程已死、或坏锁且过了初始化窗口时接管；
 * - 接管用 rename 到唯一临时名（原子），不会删掉别人刚创建的新锁；
 * - 每次持锁有唯一 id，release 只删自己那一把，重复调用也安全；
 * - 所有重试都有总期限和退避，不会无界循环。
 */
export async function acquireLock(dir, { waitMs = 3000, initMs = 2000 } = {}) {
  const file = path.join(dir, '.lock');
  const mine = crypto.randomUUID();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), id: mine })); }
      finally { fs.closeSync(fd); }
      return () => {
        let cur;
        try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
        if (!cur || cur.id !== mine) return;   // 不是自己的（或已被接管），不删
        try { fs.unlinkSync(file); } catch { /* 已被清理 */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) throw new BusyError();
      let info = null, mtime = 0;
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 空/坏锁 */ }
      try { mtime = fs.statSync(file).mtimeMs; } catch { await sleep(20); continue; }
      const live = info && Number.isSafeInteger(info.pid) && alive(info.pid);
      if (live) throw new BusyError();
      if (!info && Date.now() - mtime < initMs) {
        // 别的进程刚创建、还没写完内容：等一会再判断
        await sleep(50);
        continue;
      }
      // 接管：rename 是原子的，抢不到就重试；抢到后删临时名
      const tmp = file + '.stale.' + process.pid + '.' + crypto.randomUUID();
      try { fs.renameSync(file, tmp); } catch { await sleep(20); continue; }
      try { fs.unlinkSync(tmp); } catch { /* 删不掉也继续，临时名不会被当成锁 */ }
      await sleep(10);
    }
  }
}
