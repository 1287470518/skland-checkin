// 通知插件 —— 默认不推送，想要推送再挂一个
async function postJson(url, payload, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  // 通用 webhook 的契约仅为 HTTP 2xx；不读取、更不回显目标响应体。
  return { status: res.status };
}

/** 每种通知器：({ title, text, raw }) => Promise<void> */
export const notifiers = {
  none: async () => {},
  stdout: async ({ title, text }) => { console.log('[' + title + ']\n' + text); },
  webhook: async ({ title, text, raw }, opts = {}) => {
    if (!opts.url) throw new Error('webhook 需要 --notify-url');
    const payload = opts.template === 'text' ? { text: title + '\n' + text } : { title, text, raw };
    const r = await postJson(opts.url, payload);
    if (r.status < 200 || r.status >= 300) throw new Error('webhook HTTP 状态错误');
  },
  bark: async ({ title, text }, opts = {}) => {
    if (!opts.url) throw new Error('bark 需要 --notify-url（形如 https://api.day.app/你的key）');
    const u = opts.url.replace(/\/$/, '') + '/' + encodeURIComponent(title) + '/' + encodeURIComponent(text);
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (res.status < 200 || res.status >= 300) throw new Error('bark HTTP 状态错误');
  },
  serverchan: async ({ title, text }, opts = {}) => {
    const key = opts.key || process.env.SERVERCHAN_KEY;
    if (!key) throw new Error('serverchan 需要 --notify-key 或 SERVERCHAN_KEY');
    const r = await postJson('https://sctapi.ftqq.com/' + key + '.send', { title, desp: text });
    if (r.status < 200 || r.status >= 300) throw new Error('serverchan HTTP 状态错误');
  },
};

export function makeNotifier(type, opts = {}) {
  if (!Object.hasOwn(notifiers, type)) throw new Error('未知的通知方式：' + type + '（可选：' + Object.keys(notifiers).join(' / ') + '）');
  const fn = notifiers[type];
  return (msg) => fn(msg, opts);
}
