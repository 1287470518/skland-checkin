// 本地状态：每个账号上次签到成功/尝试时间、显示名。不存 token 本身（token 在 tokens.txt）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const defaultDir = () => process.env.SKLAND_CHECKIN_DIR || path.join(os.homedir(), '.config', 'skland-checkin');
export const keyOf = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);

export class State {
  constructor({ dir } = {}) {
    this.dir = dir || defaultDir();
    this.file = path.join(this.dir, 'state.json');
  }
  read() {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return o && typeof o === 'object' && o.accounts && typeof o.accounts === 'object' ? o : { version: 1, accounts: {} };
    } catch { return { version: 1, accounts: {} }; }
  }
  write(o) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, this.file);
  }
  get(token) { return this.read().accounts[keyOf(token)] || null; }
  set(token, patch) {
    const o = this.read();
    const k = keyOf(token);
    o.accounts[k] = { ...(o.accounts[k] || {}), ...patch };
    this.write(o);
  }
  remove(token) { const o = this.read(); delete o.accounts[keyOf(token)]; this.write(o); }
  markSuccess(token, nickname) {
    const today = new Date().toISOString().slice(0, 10);
    this.set(token, { nickname: nickname || undefined, lastSuccess: today, lastAttempt: new Date().toISOString(), lastError: null });
  }
  markAttempt(token, error) {
    this.set(token, { lastAttempt: new Date().toISOString(), lastError: error ? String(error).slice(0, 200) : null });
  }
  /** 今天是否已经成功签过 */
  signedToday(token) {
    const c = this.get(token);
    return !!(c && c.lastSuccess === new Date().toISOString().slice(0, 10));
  }
}
