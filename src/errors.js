// 只从本地错误类型和有限的数字状态生成文案；上游 message / Error.message 不作输出。
const TYPES = {
  HTTP: 'HTTP 状态错误', BUSINESS: '业务错误', STRUCTURE: '响应结构错误',
  NON_JSON: '响应不是 JSON', INPUT: '输入错误',
};
const OPERATIONS = new Set(['grant', '换 cred', '取绑定列表', '签到']);

export class CheckinError extends Error {
  constructor(type, { operation, status, code } = {}) {
    const kind = Object.hasOwn(TYPES, type) ? type : 'STRUCTURE';
    const op = OPERATIONS.has(operation) ? operation : '请求';
    const http = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const business = Number.isSafeInteger(code) ? code : undefined;
    super(op + '失败：' + TYPES[kind] + (http === undefined ? '' : ' HTTP ' + http) + (business === undefined ? '' : ' code=' + business));
    this.name = 'CheckinError';
    this.operation = op;
    this.type = kind;
    this.status = http;
    this.code = business;
  }
}

export function safeCacheError() {
  // 缓存类错误只给固定文案：不暴露路径、编码、原文件内容或上游细节。
  return '本地缓存错误（不影响签到结果，见 README「凭据缓存」）';
}

export function safeError(error) {
  if (error instanceof CheckinError) {
    // 不信任可变的 message，重新通过有限字段生成。
    return new CheckinError(error.type, { operation: error.operation, status: error.status, code: error.code }).message;
  }
  if (error instanceof TypeError) return '类型错误';
  if (error instanceof SyntaxError) return '格式错误';
  if (error instanceof RangeError) return '范围错误';
  return '操作失败';
}
