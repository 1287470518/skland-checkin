// 给 QQ 机器人 / 定时脚本的示例：签到并取出结果
import { checkinAll } from '../src/api.mjs';

const results = await checkinAll();
for (const r of results) {
  if (r.skipped) console.log(r.key, '今天已签，跳过');
  else if (r.ok) console.log(r.key, '签到成功：', (r.results || []).map((x) => x.label + ' ' + (x.ok ? '✅' : x.already ? '已签' : '❌')).join(' / '));
  else console.log(r.key, '失败：', r.error || '有角色失败');
}
