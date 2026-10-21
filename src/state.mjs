// 本地状态：每个账号上次签到成功/尝试时间、显示名。不存 token 本身（token 在 tokens.txt）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const defaultDir = () => process.env.SKLAND_CHECKIN_DIR || path.join(os.homedir(), '.config', 'skland-checkin');
export const keyOf = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
/** 本地日期（YYYY-MM-DD），用本地时区而不是 UTC（审查：UTC 会让凌晨 00:10 误判已签）。 */
export const localDate = (d = new Date()) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

export class State {
  constructor({ dir } = {}) {
    this.dir = dir || defaultDir();
    this.file = path.join(this.dir, 'state.json');
  }
  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, accounts: {} };
      throw new Error('状态文件读不出来（' + (e.code || 'unknown') + '）');
    }
    let o;
    try { o = JSON.parse(raw); } catch {
      // 损坏就备份，不静默丢（审查：持久化丢数据）
      const bak = this.file + '.corrupt-' + Date.now();
      try { fs.copyFileSync(this.file, bak); } catch { /* 备份失败也继续，原文件保留 */ }
      throw new Error('状态文件损坏（已备份为 ' + bak + '），删掉它再试');
    }
    if (!o || typeof o !== 'object' || Array.isArray(o) || !o.accounts || typeof o.accounts !== 'object' || Array.isArray(o.accounts)) {
      throw new Error('状态文件结构不对，请删掉 ' + this.file + ' 后重试');
    }
    return o;
  }
  write(o) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(o, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原错误 */ }
      throw e;
    }
  }
  get(token) { try { return this.read().accounts[keyOf(token)] || null; } catch { return null; } }
  set(token, patch) {
    const o = this.read();
    const k = keyOf(token);
    o.accounts[k] = { ...(o.accounts[k] || {}), ...patch };
    this.write(o);
  }
  remove(token) { const o = this.read(); delete o.accounts[keyOf(token)]; this.write(o); }
  markSuccess(token, nickname) {
    this.set(token, { nickname: nickname || undefined, lastSuccess: localDate(), lastAttempt: new Date().toISOString(), lastError: null });
  }
  markAttempt(token, error) {
    this.set(token, { lastAttempt: new Date().toISOString(), lastError: error ? String(error).slice(0, 200) : null });
  }
  signedToday(token) {
    const c = this.get(token);
    return !!(c && c.lastSuccess === localDate());
  }
}
