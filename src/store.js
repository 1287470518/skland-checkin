// 凭据缓存：由调用方决定何时重建；本模块不自动检测失效或续期。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const 默认目录 = () => process.env.SKLAND_CHECKIN_DIR || path.join(os.homedir(), '.config', 'skland-checkin');

export function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

export class CredStore {
  constructor({ dir } = {}) {
    this.dir = dir || 默认目录();
    this.file = path.join(this.dir, 'creds.json');
  }

  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return { version: 1, accounts: {} };   // 首次使用，正常
      throw new Error('凭据缓存读不出来（' + (e.code || e.message) + '），为避免覆盖它已停止写入');
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      // ⚠️ 2026-10-21 终审：解析失败**绝不能**当空库返回 —— 那样下次写入会把原文件覆盖掉。
      //   先备份成 .corrupt-<时间>，再报错让人处理。
      throw new Error('凭据缓存已损坏（原文件备份为 ' + this.backupCorrupt() + '），请检查或删除后重试');
    }
    // ⚠️ 2026-10-21 四审：不只是「能不能 parse」，**结构也要对**。
    //   例如 accounts 被写成数组时，put 会往数组上挂属性（JSON.stringify 丢字段）⇒ 看起来写成功、实际存不住。
    const okShape = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && parsed.accounts && typeof parsed.accounts === 'object' && !Array.isArray(parsed.accounts);
    if (!okShape) throw new Error('凭据缓存结构不对（原文件备份为 ' + this.backupCorrupt() + '），请检查或删除后重试');
    // ⚠️ 2026-10-21 整体审核 M02：只验根结构不够，version 与每条凭据的字段也要卡。
    if (parsed.version !== 1) throw new Error('凭据缓存版本不支持（原文件备份为 ' + this.backupCorrupt() + '），请检查或删除后重试');
    for (const key of Object.keys(parsed.accounts)) {
      const v = parsed.accounts[key];
      const okEntry = v && typeof v === 'object' && !Array.isArray(v)
        && typeof v.cred === 'string' && v.cred.length > 0
        && typeof v.signToken === 'string' && v.signToken.length > 0
        && (v.userId === undefined || typeof v.userId === 'string')
        && (v.at === undefined || (typeof v.at === 'number' && Number.isFinite(v.at)));
      if (!okEntry) throw new Error('凭据缓存条目结构不对（原文件备份为 ' + this.backupCorrupt() + '），请检查或删除后重试');
    }
    return parsed;
  }

  /** 备份损坏的缓存文件，返回备份路径（备份失败也照样报错，不掩盖原问题） */
  backupCorrupt() {
    const bak = this.file + '.corrupt-' + Date.now();
    try { fs.copyFileSync(this.file, bak); } catch { return bak + '（备份失败）'; }
    return bak;
  }

  write(o) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // 放在同目录、名称唯一；**创建即 0600**（不是写完再 chmod，那样中间有一段时间别人可读）
    const tmp = this.file + '.' + process.pid + '.' + Date.now() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(o, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败也不掩盖原错误 */ }
      throw e;
    }
    // Windows 上 mode 不完全等价于 ACL，这里只是尽力而为；敏感场景请自己限制目录权限
  }

  /** 取缓存凭据；overdueMs 内不认为是过期 */
  get(token, { overdueMs = 0 } = {}) {
    const c = this.read().accounts[tokenKey(token)];
    if (!c || !c.cred || !c.signToken) return null;
    if (overdueMs && Date.now() - (c.at || 0) > overdueMs) return null;
    return c;
  }

  put(token, { cred, signToken, userId }) {
    const o = this.read();
    o.accounts[tokenKey(token)] = { cred, signToken, userId: userId || '', at: Date.now() };
    this.write(o);
  }

  invalidate(token) {
    const o = this.read();
    delete o.accounts[tokenKey(token)];
    this.write(o);
  }
}
