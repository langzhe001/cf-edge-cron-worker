# cf-edge-cron-worker

> 部署于 Cloudflare Workers / EdgeOne Edge Functions 的定时任务脚本。
> 双任务轮转 + 多账号用量监控 + 85% 阈值告警 + 外链纯净度筛选推送 + 黑客风鉴权面板。

![cron](https://img.shields.io/badge/cron-0%20*/4%20*%20*%20*-00ff66)
![platform](https://img.shields.io/badge/platform-Cloudflare%20Workers%20%7C%20EdgeOne-4f8cff)
![lang](https://img.shields.io/badge/lang-TypeScript-3178c6)

## ✨ 功能概览

| 任务 | 触发时间 (UTC) | 功能 |
|---|---|---|
| **任务一** | 0 / 8 / 16 时 | 轮询多个 Cloudflare 账号的免费版用量（Workers 调用 / D1 行读写 / R2 Class A/B），任一项 ≥ 85% 阈值时通过 Notifyx 推送告警 |
| **任务二** | 4 / 12 / 20 时 | 拉取外链列表 → 并发 GET 检查 → 提取国家/ASN/IP 属性/纯净度 → 过滤（超时/错误/非住宅 IP/纯净度不达标）→ 拼接 `另一组数据#国家[纯净度]$链接` → POST 推送 |

Cron `0 */4 * * *` 每 4 小时整点触发，单次只跑一个任务（按 UTC 小时 % 8 分流）。

## 🏗️ 架构

```
src/
├── index.ts              # 主入口：scheduled(cron) + fetch(HTTP API/面板)
├── cloudflare-usage.ts   # 任务一：多账号 CF 用量轮询（GraphQL）
├── task2.ts              # 任务二：外链检查 + 纯净度过滤 + 拼接推送
├── ip-info.ts            # IP 归一化 / 纯净度评分（移植自 CF-Workers-CheckSocks5）
├── notify.ts             # Notifyx 消息推送
├── limits.ts             # Cloudflare 免费版额度定义
└── dashboard.html        # 黑客风监控面板（密码鉴权）
```

## 📊 住宅 IP 与纯净度

**住宅 IP 判定**（任务二过滤）：
- 风险标志全部为 false：`is_datacenter / is_proxy / is_vpn / is_tor / is_crawler / is_abuser / is_bogon`
- `company.type === "isp"` **且** `asn.type === "isp"`

**纯净度评分**（移植自 [cmliu/CF-Workers-CheckSocks5](https://github.com/cmliu/CF-Workers-CheckSocks5)）：
```
baseScore = ((company.abuser_score + asn.abuser_score) / 2) * 5
finalScore = baseScore + riskCount * 0.15 + (is_bogon ? 1.0 : 0)
等级: <0.25% 极度纯净 | <5% 纯净 | <20% 轻微风险 | <100% 高风险 | ≥100% 极度危险
```

任务二保留 `极度纯净 / 纯净 / 未知` 三档，排除 `轻微风险 / 高风险 / 极度危险`。

## 🔐 鉴权

- 面板与所有 `/api/*` 接口需 `AUTH_PASSWORD`
- 面板登录：密码 → `POST /api/login` → 存 localStorage → API 自动带 `Authorization: Bearer <pwd>`
- API 调用：`Authorization: Bearer <pwd>` 头 或 `?token=<pwd>` 参数
- **cron `scheduled()` 不经过 fetch 鉴权层，完全不受影响**
- 未配置 `AUTH_PASSWORD` 时自动放行（无登录遮罩）

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 创建 KV namespace，把返回的 id 填入 wrangler.toml
npx wrangler kv namespace create CONFIG_KV

# 3. 注入 secrets（切勿写入 wrangler.toml）
npx wrangler secret put AUTH_PASSWORD
npx wrangler secret put CF_ACCOUNTS
npx wrangler secret put NOTIFYX_WEBHOOK
npx wrangler secret put TASK2_LIST_URL
npx wrangler secret put TASK2_CHECK_BASE_URL
npx wrangler secret put TASK2_EXTRA_DATA_URL
npx wrangler secret put TASK2_PUSH_URL

# 4. 部署
npx wrangler deploy
```

详细配置见 [DEPLOY.md](./DEPLOY.md)。

## 📡 HTTP API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/` | — | 监控面板 HTML |
| POST | `/api/login` | — | 登录校验 `{password}` → `{ok}` |
| GET | `/api/status` | ✓ | 双任务最近运行状态 |
| GET | `/api/usage` | ✓ | 任务一：多账号用量报告 |
| GET | `/api/task2/result` | ✓ | 任务二：过滤统计 + 推送预览 |
| POST | `/api/run?task=1` | ✓ | 手动触发任务一 |
| POST | `/api/run?task=2` | ✓ | 手动触发任务二 |

## ⚙️ 性能优化

- **滑动窗口并发**：任务二用 worker 池并发（非整批 `Promise.all`），快的请求先释放槽位
- **单请求超时**：`AbortController` 默认 8s，避免慢请求拖垮整体
- **去重截断**：外链列表去重 + 截断到 80 条
- **subrequest 控制**：任务二纯净度本地运算（不额外调 ipapi.is），单次 invocation 控制在 50 subrequest 内
- **多账号并发**：`fetchAllAccountsUsage` 用 `Promise.all`，单账号失败不影响其它

## 🙏 致谢

- [cmliu/CF-Workers-CheckSocks5](https://github.com/cmliu/CF-Workers-CheckSocks5) — IP 归一化与纯净度评分算法来源
- [Notifyx](https://notifyx.cc/) — 消息推送服务

## 📄 License

MIT
