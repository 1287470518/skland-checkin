// CLI/UI 的输入提示，不猜测凭据的 Base64/JWT 编码；core 不限制 token 的字符语言。
export function tokenInputError(token) {
  if (typeof token !== 'string') return 'token 必须是字符串';
  if (!token.trim()) return '请先填入 token';
  if (token.length > 4096) return 'token 太长（最多 4096 字符）';
  if (/[\u0000-\u001f\u007f]/u.test(token)) return 'token 不能含控制字符';
  return '';
}
