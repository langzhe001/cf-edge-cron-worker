# 部署文档

本文档介绍如何将 `cf-edge-cron-worker` 部署到 Cloudflare Workers（推荐）。EdgeOne Edge Functions 的适配见文末。

---

## 一、前置准备

1. **Cloudflare 账号**：注册 https://dash.cloudflare.com/
2. **Node.js ≥ 18** 与 npm
3. **Wrangler CLI**：本项目已含，全局也可装 `npm i -g wrangler`
4. **登录 Wrangler**：
   ```bash
   npx wrangler login
   ```

## 二、克隆与安装

```bash
git clone https://github.com/langzhe001/cf-edge-cron-worker.git
cd cf-edge-cron-worker
npm install
```

## 三、创建 KV Namespace

本项目用 KV 存配置与缓存结果。创建后把返回的 `id` 填入 `wrangler.toml`。

```bash
# 创建生产 namespace
npx wrangler kv namespace create CONFIG_KV
# 输出示例:
# { "binding": "CONFIG_KV", "id": "abcd1234..." }

# 创建预览 namespace（本地开发用）
npx wrangler kv namespace create CONFIG_KV --preview
```

编辑 `wrangler.toml`，把两个 id 填入：

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "上一步返回的 id"
preview_id = "预览 namespace 的 id"
```

## 四、配置环境变量（Secrets）

⚠️ **所有敏感信息必须用 `wrangler secret put` 注入，切勿写入 `wrangler.toml` 或提交到 git。**

### 4.1 面板鉴权（必填）

```bash
npx wrangler secret put AUTH_PASSWORD
# 输入一个强密码，作为面板登录密码与 API Bearer token
```

### 4.2 任务一：Cloudflare 多账号用量

**方式 A：多账号（推荐）** — `CF_ACCOUNTS` 为 JSON 数组：

```bash
npx wrangler secret put CF_ACCOUNTS
# 粘贴如下格式（每个账号 id + token + 别名）:
[{"id":"accId1","token":"token1","name":"main"},{"id":"accId2","token":"token2","name":"backup"}]
```

**获取 Account ID**：Cloudflare 控制台 → 任意域名 → 右侧 Overview → Account ID。

**获取 API Token**：https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token，权限：
- `Account` → `Account Analytics` → Read
- `Account` → `Workers Scripts` → Read

**方式 B：单账号（向后兼容）**：

```bash
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
```

### 4.3 任务一：Notifyx 告警推送（可选）

```bash
npx wrangler secret put NOTIFYX_WEBHOOK
# 填你的 Notifyx 推送 URL，格式: https://www.notifyx.cc/api/v1/send/<你的key>
```

阈值默认 85%，可在 `wrangler.toml` 调整 `ALERT_THRESHOLD`（或在 secrets 里覆盖）。

### 4.4 任务二：外链检查 + 推送

```bash
# 1) 外链列表 URL（GET 返回纯文本，每行一个标识符）
npx wrangler secret put TASK2_LIST_URL

# 2) 检查接口 base URL（GET base+每行标识符，返回 CheckSocks5 风格 JSON）
#    响应格式: { "link": "socks5://...", "exit": { ip, is_datacenter, company:{abuser_score,type}, asn:{asn,abuser_score,org,type}, location:{country,country_code,city} } }
npx wrangler secret put TASK2_CHECK_BASE_URL

# 3) 另一组数据 URL（GET 返回纯文本，每行一个字符串，行数少于链接时循环复用）
npx wrangler secret put TASK2_EXTRA_DATA_URL

# 4) 最终拼接数据推送 URL（POST，body 为每行一条文本）
npx wrangler secret put TASK2_PUSH_URL
```

### 4.5 性能参数（可选，已在 wrangler.toml 默认值）

```toml
TASK2_MAX_ITEMS = "80"        # 单次最多处理多少条外链
TASK2_CONCURRENCY = "10"      # 滑动窗口并发数
TASK2_TIMEOUT_MS = "8000"     # 单请求超时（毫秒）
```

> ⚠️ Cloudflare 免费版单次 invocation 最多 50 subrequest。任务二每个外链 = 1 个 GET，加上列表与 extra 两个 fetch。若用免费版，请把 `TASK2_MAX_ITEMS` 调到 ≤ 40。

## 五、部署

```bash
npx wrangler deploy
```

部署成功后输出：
```
Published cf-edge-cron-worker
  https://cf-edge-cron-worker.<你的子域>.workers.dev
  Current Version ID: ...
```

## 六、验证

1. **面板**：浏览器打开 Worker 域名，输入 `AUTH_PASSWORD` 登录。
2. **手动触发**：面板点 `[ RUN T1 ]` / `[ RUN T2 ]`，或：
   ```bash
   curl -X POST -H "Authorization: Bearer $AUTH_PASSWORD" \
     https://cf-edge-cron-worker.<你的子域>.workers.dev/api/run?task=1
   ```
3. **Cron**：Cloudflare 控制台 → Workers & Pages → 你的 Worker → Triggers → Cron Events，可看到下次触发时间。

## 七、Cron 调度说明

`wrangler.toml` 配置 `crons = ["0 23,3,7,11,15,19 * * *"]`，每 4 小时触发一次，单次只跑一个任务。Worker 内部按 UTC 小时分流：

| UTC 小时 | 任务 |
|---|---|
| 11, 19, 23 | 任务一（CF 用量轮询 + 告警） |
| 3, 7, 15 | 任务二（外链检查 + 推送） |

任务一当天最后一次运行在 **UTC 23:00**，贴近 0 点免费版日限额刷新前，能捕捉当日用量峰值并触发告警。

## 八、本地开发

```bash
# 启动本地 dev server（带热重载，访问 http://localhost:8787）
npx wrangler dev

# 本地 secrets 放 .dev.vars 文件（已 gitignore）
# 格式:
# AUTH_PASSWORD=xxx
# CF_ACCOUNTS=[{...}]
```

## 九、EdgeOne 适配

EdgeOne Edge Functions 与 Cloudflare Workers 的运行时接近（基于 V8），主要差异：

| Cloudflare | EdgeOne |
|---|---|
| `KVNamespace` | EdgeOne KV（API 一致） |
| `ScheduledEvent` / `scheduled()` | EdgeOne Cron Trigger（`cron` handler） |
| `wrangler.toml` 的 `[triggers]` | EdgeOne 控制台配置 Cron |
| `ctx.waitUntil` | EdgeOne `context.waitUntil` |

业务逻辑代码（`task2.ts` / `cloudflare-usage.ts` / `ip-info.ts` / `notify.ts`）可直接复用，仅需把 `index.ts` 的入口适配为 EdgeOne 的 `onEvent`/`onRequest` 格式。

---

## 故障排查

| 现象 | 排查 |
|---|---|
| 面板登录后立即跳回登录 | `AUTH_PASSWORD` 未配置 → 面板自动放行；已配置但 token 不匹配 → 重新登录 |
| 任务一 `reports[].error` 有值 | API Token 权限不足或 Account ID 错误，检查 token 权限含 `Account Analytics: Read` |
| 任务一无告警 | 检查 `NOTIFYX_WEBHOOK` 是否配置；用量是否真到 85% |
| 任务二全部 timeout | `TASK2_CHECK_BASE_URL` 不可达或超时太短，增大 `TASK2_TIMEOUT_MS` |
| 任务二 subrequest 超限 | 免费版调小 `TASK2_MAX_ITEMS`（≤40） |
| 任务二推送失败 | 检查 `TASK2_PUSH_URL` 与对端服务日志 |

## 配置速查表

| 变量 | 必填 | 用途 | 注入方式 |
|---|---|---|---|
| `AUTH_PASSWORD` | ✓ | 面板/API 鉴权 | secret put |
| `CF_ACCOUNTS` 或 `CF_ACCOUNT_ID`+`CF_API_TOKEN` | ✓ | 任务一 CF 凭据 | secret put |
| `NOTIFYX_WEBHOOK` | 任务一告警 | Notifyx 推送 URL | secret put |
| `ALERT_THRESHOLD` | 可选 | 告警阈值%，默认 85 | wrangler.toml |
| `TASK2_LIST_URL` | 任务二 | 外链列表 URL | secret put |
| `TASK2_CHECK_BASE_URL` | 任务二 | 检查接口 base URL | secret put |
| `TASK2_EXTRA_DATA_URL` | 任务二 | 另一组数据 URL | secret put |
| `TASK2_PUSH_URL` | 任务二 | 推送 URL | secret put |
| `TASK2_MAX_ITEMS` | 可选 | 单次最多处理条数，默认 80 | wrangler.toml |
| `TASK2_CONCURRENCY` | 可选 | 并发数，默认 10 | wrangler.toml |
| `TASK2_TIMEOUT_MS` | 可选 | 单请求超时 ms，默认 8000 | wrangler.toml |
