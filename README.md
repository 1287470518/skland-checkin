# skland-checkin

森空岛（**明日方舟** / **终末地**）自动签到。纯 Node 命令行，**零依赖**，不需要青龙、不需要 Docker、不需要任何面板。

运行环境：**Node.js >=18**。离线测试（源码仓库）：`node --test test/core.test.mjs`；Release 的 Windows 包不含 `test/` 目录。

> ⚠️ 非官方工具，调用的是森空岛自己网页在用的接口。账号风险自负，详见文末。

## 它做什么 / 不做什么

**做**：拿你的 token 登录森空岛 → 换凭据 → 读出你绑定的所有角色 → 给每个角色签到 → 打印结果（可选推送通知）。

**不做**：不抽卡、不分析数据、不导出图片。登录、获取绑定各有请求，每个角色再发一次签到请求。

## 快速开始

### 1. 拿 token

浏览器登录 <https://www.skland.com/>，然后打开：

```
https://web-api.skland.com/account/info/hg
```

页面会返回一段 JSON，复制 `data.content` 里的那串字符串。

> 这串就是你的登录凭证，**等同于账号密码**。不要发给任何人，不要提交进 git。

### 2. 跑一次

```bash
node src/cli.js --token "<你的 token>"
```

正常输出：

```
账号 · arknights · 示例用户#8430 → ✅ 签到成功（龙门币）
账号 · endfield · 示例用户 → 已经签过

成功 1 · 已签 1 · 失败 0（共 2） · 整号失败 0
```

### 3. 双击打开签到助手（推荐）

解压后双击 `签到助手.bat`，会打开一个小窗口：

1. 点「登录森空岛」，在弹出的浏览器窗口里登录（用你自己的森空岛账号）
2. 回到助手点「获取 token 并绑定」——助手会自己打开 token 接口页、读出 token、拿到游戏 ID，然后立即关掉浏览器窗口
3. 账号出现在列表里就绑好了，之后每天自动签到（电脑开着、这个用户已登录时）

- 支持多个账号：重复上面两步
- 删除账号：列表里点「删除」
- 绑定后会自动创建每天 00:10 的任务；双击助手时也会检查今天有没有签过

### 3.1 Windows 一键签到（命令行方式）

账号已经在 `tokens.txt` 里时，也可以直接双击 `一键签到.bat` 跑一次。

下载[最新 Release](https://github.com/youyizhidafeiyu/skland-checkin/releases/latest) 的 Windows 包（`skland-checkin-*-windows.zip`，约 30MB，win-x64，内含 `node.exe`，不用另外装 Node），解压后双击 `一键签到.bat`：

- 第一次会提示你把 token 复制到剪贴板再按任意键，脚本自己写进 `tokens.txt`，窗口不显示 token；
- 之后每次双击就能签到，结束窗口不会闪退；
- 想用自己装的 Node 也可以：删掉包里的 `node.exe` 就会用系统的 Node（18+）；
- 升级：新包解压到新目录，再把自己的 `tokens.txt` 复制过去；不要用新包覆盖旧目录（会换成模板）；
- 如果 `tokens.txt` 里已经有能用的 token，脚本不会覆盖它；导入失败或文件编码不对会提示并保留原文件。

也可以手动用记事本编辑 `tokens.txt`（一行一个 token，或一行一个 `{"name":"账号名","token":"..."}` JSON），再双击。

### 4. 每天自动签到（设置一次，之后不用点）

双击 `设置每天自动签到.bat`，它会在 Windows 任务计划里建一个每天 **08:00** 的任务，之后电脑开着、这个用户已登录时就会自动跑。

- 换时间：在命令行运行 `node src\cli.js --install-task 07:30`（会替换同名任务）
- 取消：双击 `取消自动签到.bat`（命令行 `--uninstall-task`）
- 关机、睡眠或没登录时不会跑；任务计划默认「电池供电时不启动」，插电时才会跑；想更稳可以改用服务器常驻
- 移动或升级目录前：先在旧目录双击「取消自动签到.bat」，再到新目录设置；不然旧任务会一直指向旧路径

### 5. 加定时（cron / 任务计划 / Actions）

**Linux / macOS（cron，每天 08:00）**

```bash
0 8 * * * cd /path/to/skland-checkin && node src/cli.js --token-file tokens.txt --notify webhook --notify-url https://example.com/hook
```

**Windows（任务计划程序）**：操作填 `node.exe`，参数填 `src\cli.js --token-file tokens.txt`，起始于填仓库目录；用便携包时，操作要填解压目录下 `node.exe` 的绝对路径。

**GitHub Actions**：本仓库不提供 workflow。自行创建任务时，把 token 放进 Secret `SKLAND_TOKEN`，在步骤中显式映射：

```yaml
env:
  SKLAND_TOKEN: ${{ secrets.SKLAND_TOKEN }}
run: node src/cli.js --token "$SKLAND_TOKEN" --no-cache
```

CLI 不会自动读取 `SKLAND_TOKEN`；上例由 shell 传入参数。使用该例的 runner 需已安装 Node >=18 并签出仓库。

## 多账号

建一个 `tokens.txt`：

```
# 每行一个原样 token；要命名就写 JSON 对象，不用等号猜分隔符
SYNTHETIC_TOKEN_WITH_PADDING==
{"name":"账号B","token":"SYNTHETIC_TOKEN_B"}
```

```bash
node src/cli.js --token-file tokens.txt
```

旧的 `名字=token` 语法已移除，请改为上述 JSON 对象；普通行中的所有等号都属于 token。token 不限制 Base64/JWT 编码；CLI/UI 只要求非空字符串、最多 4096 字符、不含控制字符。

## 图形界面（可选）

不想用命令行的话：

```bash
node src/server.js
```

浏览器打开 <http://127.0.0.1:8977>，把 token 贴进去点「签到」就行。

- **只监听 127.0.0.1**，同一局域网的其他机器访问不到；
- 页面会拦跨站请求（Origin 只认本机），防止别的网页偷偷往你本机发请求；
- 成功响应只包含角色结果；错误只返回本地固定类型/短语，不回显上游 message。顶层异常在 stderr 留关联号与安全分类；角色名和奖励名仍是上游显示数据，不保证任意字段都不含敏感内容；
- 页面勾「记住」后，**点击签到时**才写入 localStorage；取消勾选也是下次点签到时删除，立即删除请点「清空」。服务端凭据缓存独立于这个勾选项；
- 同一 token 正在处理时再次提交会返回 429；不等待或共享首次结果。不同 token 使用完整 SHA256 区分；
- 端口可用 `SKLAND_UI_PORT` 环境变量改。

## 被别的项目当库用

`src/core.js` 提供可导入的异步 HTTP 操作，默认会访问真实接口：

```js
import { login, getBindings, checkinRole, checkinToken } from './src/core.js';

const { cred, signToken } = await login(token);      // 也可以自己传 cred 复用
const apps = await getBindings(cred, signToken);      // [{ appCode, bindingList: [...] }]
for (const app of apps) for (const role of app.bindingList)
  console.log(await checkinRole(role, app.appCode, cred, signToken));
```

网络操作 `grantCode / exchangeCred / login / getBindings / checkinRole / checkinToken` 接受 `{ fetchImpl }`；不传时使用真实 fetch。`pyJson / signHeaders` 是本地序列化和签名工具。

core 不按编码形状拒绝 token；输入提示属于 CLI/UI。`pyJson` 保留 JSON 字符串的语义值，只在结构冒号后加空格；签名和发送使用同一字符串。兑换和签到强制不重试，即使调用方传入 `retries`；grant 和绑定默认对网络瞬时错误、429/5xx 最多重试两次。兑换或签到遇到网络错误时结果可能未知，应人工确认，避免自动重跑。

## 通知

**默认 `--notify none`，完全不推送**，只在终端打印结果。要推送再加参数：

| `--notify` | 怎么配 |
|---|---|
| `stdout` | 直接往终端打一遍（会和正常输出重复，调试用） |
| `webhook` | `--notify-url <url>`，会 POST `{title, text, raw}`；加 `--notify-template text` 改成 POST `{text}` |
| `bark` | `--notify-url https://api.day.app/<你的key>` |
| `serverchan` | `--notify-key <SendKey>` 或设环境变量 `SERVERCHAN_KEY` |

通知目前只以 HTTP 2xx 为发送成功，不验证目标业务响应体；通用 webhook 需由接收端实现自己的业务成功契约。通知失败写 stderr，不改变签到退出码。

`--json` 输出 `{summary, results, accountErrors}`，通知 `raw` 使用相同结构。`summary.ok/already/bad/total` 仅计角色；`summary.accountErrors` 计整号失败。`accountErrors` 含从 0 开始的 `accountIndex`、名称和安全错误文案；失败账号不伪造角色结果。没有绑定角色是合法空结果，文本模式会明确提示。

CLI 退出码：`0` 表示角色成功/已签或合法空绑定；`1` 表示至少一个账号/角色失败或运行错误；`2` 表示参数/输入格式错误。`--json --notify stdout` 会额外打印通知文本；需要纯 JSON stdout 时使用默认 `none` 或其他非 stdout 通知器。

想接企业微信 / 飞书 / Discord / Telegram？用 `webhook` 自己转一下，或者照 `src/notify.js` 加一个几行的通知器。

## 凭据缓存

换来的凭据会缓存在 `~/.config/skland-checkin/creds.json`（可用 `SKLAND_CHECKIN_DIR` 改位置）。

有缓存时直接复用，**不会自动失效重登**。缓存失效会报错，请手动加 `--no-cache` 重新登录；成功后写入新的缓存。

- 想强制重建：`--no-cache`
- 想清掉某账号的缓存：删掉 `creds.json` 里对应的那条

缓存目录里有 `.lock` 做单实例互斥：CLI 和本地 UI 在同一个缓存目录下不会同时读写，冲突时会提示「另一个签到实例正在运行」（UI 返回 409）。仍没有全局并发上限、整批时限或断开取消；缓存损坏/权限错误会区分并备份，schema 只做基础校验（version 与条目字段类型）。旧文件权限不会自动迁移；POSIX mode 不代表 Windows ACL 隔离，请自行限制缓存目录权限。

## 返回码含义

| code | 含义 | 该怎么办 |
|---|---|---|
| `0` | 签到成功 | 不用管 |
| `10001` | 仅在签到响应中解释为「已经签过」 | 登录/绑定不接受这个码 |
| 其他 | 业务失败或结构/HTTP 错误 | 查看安全错误类型、数字 code 与 HTTP 状态 |

> 遇到未识别响应，请在 issue 提供阶段、安全错误类型、数字状态和合成最小复现。不要公开完整响应、请求头、token、cred、signToken 或缓存内容。真实协议兼容性须单独验证，离线测试不代表接口已接通。

## 常见错误

| 现象 | 原因 | 怎么办 |
|---|---|---|
| HTTP 403 | 可能是接口风控（具体原因无法从响应确认） | 先停几小时再试，别连续跑；2026-10-21 凌晨短期内多次调试后出现过 |
| code 10001 | 「请勿重复签到」= 今天已经签过 | 正常，不是错误 |
| 10000 / 参数错误 | 请求体或签名不对 | 看安全错误类型和数字状态；上游 message 默认不回显 |
| 「响应结构错误」 | 上游返回结构和预期不一致 | 接口可能改版了，按 issue 模板给安全分类与数字状态 |

## 免责声明

- 这是**非官方**第三方工具，与鹰角网络 / 森空岛无任何关系。
- 它调用的是网页端接口。接口随时可能变化，也可能带来账号风险，**自负**。
- token 等于账号密码。token、cred、signToken、账号标识和通知密钥均可能敏感；不要外传或提交凭据文件。`--token-file` 支持自定义文件名，创建者须自行加入忽略规则。
- 请合理设置频率（建议每天一次），不要拿它刷接口。

## 来源与授权

本项目的接口调用方式、签名算法与参数结构来自公开的网页端行为观察，**不是**官方文档。

- 重试策略（仅对瞬时故障退避重试）借鉴自 `devnakx/skyland_auto_checkin` 的 README 描述，属**思路借鉴**，代码为本项目独立实现；
- 未直接复制或翻译任何其他项目的源码；如果你发现相似度异常高的片段，欢迎提 issue 指出；
- 本仓库全部代码以 MIT 授权发布，作者不主张其中任何第三方接口或协议的权利。

## License


MIT

源码内的具体上游复用范围、固定版本与授权链尚未核实；本项目的 MIT 声明不代替上游授权证明。

仓库 `.gitignore` 忽略 `%SystemDrive%/`、`ProgramData/` 和所有 `.bin`（含两份搜狗残留二进制）；npm `files` 只选择 `src`、`public`、`LICENSE`，另有 npm 自动包含的元数据。忽略规则不移除已有跟踪或历史，也不能保护手工压整个目录；两份二进制已移出仓库目录；如发现残留，请勿提交。
