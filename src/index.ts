/**
 * Cloudflare/EdgeOne Worker 主入口
 *
 * 定时任务：每 4 小时整点触发，单次只跑一个任务
 *   UTC 0/8/16 时 → 任务一：Cloudflare 多账号用量轮询 + 85% 阈值 notifyx 告警
 *   UTC 4/12/20 时 → 任务二：外链检查 + 纯净度过滤 + 拼接推送
 *
 * 鉴权：
 *   - 面板 / API 调用需 AUTH_PASSWORD（Bearer token 或 ?token=）
 *   - cron scheduled() 内部调用，不经过 fetch 鉴权，不受影响
 *
 * 存储：KV（CONFIG_KV）—— 缓存最近一次结果 + 运行状态
 */

import dashboardHtml from "./dashboard.html";
import { fetchAllAccountsUsage, type CfAccount } from "./cloudflare-usage";
import { runTask2, type Task2Env, type Task2Result } from "./task2";
import { pushNotifyx } from "./notify";
import type { UsageReport, UsageItem } from "./limits";

export interface Env extends Task2Env {
  CONFIG_KV: KVNamespace;
  // —— 任务一：多账号 ——
  /** JSON 数组：[{"id":"accId","token":"apiToken","name":"别名"}]（secret 推荐） */
  CF_ACCOUNTS?: string;
  /** 向后兼容：单账号 */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  // —— 告警 ——
  NOTIFYX_WEBHOOK?: string;
  ALERT_THRESHOLD?: string; // 默认 85
  // —— 鉴权 ——
  AUTH_PASSWORD?: string;
}

const KV_USAGE = "report:usage";       // 任务一结果（多账号 reports 数组）
const KV_TASK2_RESULT = "report:task2"; // 任务二结果
const KV_LAST_RUN = "last_run";         // 双任务运行状态

interface LastRunStatus {
  task1?: { at: string; ok: boolean; error?: string };
  task2?: { at: string; ok: boolean; error?: string };
}

// ============ 多账号解析 ============

function parseAccounts(env: Env): CfAccount[] {
  // 优先 CF_ACCOUNTS（JSON 数组）
  if (env.CF_ACCOUNTS) {
    try {
      const arr = JSON.parse(env.CF_ACCOUNTS) as unknown;
      if (Array.isArray(arr)) {
        return arr
          .filter((a): a is CfAccount =>
            !!a && typeof a === "object" && typeof (a as CfAccount).id === "string" && typeof (a as CfAccount).token === "string")
          .map((a) => ({ id: a.id, token: a.token, name: a.name }));
      }
    } catch (err) {
      console.warn("CF_ACCOUNTS parse failed:", String(err));
    }
  }
  // 向后兼容：单账号
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
    return [{ id: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, name: env.CF_ACCOUNT_ID }];
  }
  return [];
}

// ============ 任务一：多账号用量 + 85% 告警 ============

const DEFAULT_THRESHOLD = 85;

interface AlertItem {
  accountName: string;
  item: UsageItem;
}

async function runTask1(env: Env): Promise<{ reports: UsageReport[]; alerts: AlertItem[] }> {
  const accounts = parseAccounts(env);
  if (accounts.length === 0) {
    console.warn("task1 skipped: no CF accounts configured");
    return { reports: [], alerts: [] };
  }

  const reports = await fetchAllAccountsUsage(accounts);
  const threshold = Math.max(1, parseInt(env.ALERT_THRESHOLD ?? String(DEFAULT_THRESHOLD), 10) || DEFAULT_THRESHOLD);

  // 收集所有 ≥ 阈值的项
  const alerts: AlertItem[] = [];
  for (const r of reports) {
    for (const it of r.items) {
      if (it.percent >= threshold) {
        alerts.push({ accountName: r.accountName ?? r.accountId, item: it });
      }
    }
  }

  // 85% 阈值告警 → notifyx
  if (alerts.length > 0 && env.NOTIFYX_WEBHOOK) {
    const lines = alerts.map(
      (a) => `[${a.accountName}] ${a.item.name}: ${a.item.percent}% (${a.item.used}/${a.item.limit} ${a.item.unit}, ${a.item.period})`,
    );
    await pushNotifyx(env.NOTIFYX_WEBHOOK, {
      title: `⚠️ CF 用量告警 (${alerts.length} 项 ≥ ${threshold}%)`,
      content: lines.join("\n"),
      summary: `${alerts.length} 项超阈值`,
    });
  }

  await env.CONFIG_KV.put(KV_USAGE, JSON.stringify({ generatedAt: new Date().toISOString(), reports, alerts, threshold }));
  return { reports, alerts };
}

/** 任务二：包装落 KV + 记录状态 */
async function runTask2AndStore(env: Env): Promise<Task2Result> {
  const result = await runTask2(env);
  await env.CONFIG_KV.put(KV_TASK2_RESULT, JSON.stringify(result));
  return result;
}

// ============ 运行状态记录 ============

async function recordRun(env: Env, task: 1 | 2, ok: boolean, error?: string): Promise<void> {
  try {
    const raw = await env.CONFIG_KV.get(KV_LAST_RUN);
    const status: LastRunStatus = raw ? JSON.parse(raw) : {};
    const key = task === 1 ? "task1" : "task2";
    status[key] = { at: new Date().toISOString(), ok, error: ok ? undefined : error };
    await env.CONFIG_KV.put(KV_LAST_RUN, JSON.stringify(status));
  } catch {
    /* ignore */
  }
}

// ============ Cron 调度 ============

/** 根据触发时间的小时数决定跑哪个任务（UTC 0/8/16→任务一；4/12/20→任务二） */
function pickTask(hour: number): 1 | 2 | null {
  const mod = hour % 8;
  if (mod === 0) return 1;
  if (mod === 4) return 2;
  return null;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const hour = new Date(event.scheduledTime).getUTCHours();
    const task = pickTask(hour);
    if (!task) return;

    ctx.waitUntil(
      (async () => {
        try {
          if (task === 1) await runTask1(env);
          else await runTask2AndStore(env);
          await recordRun(env, task, true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`task${task} failed:`, msg);
          await recordRun(env, task, false, msg);
        }
      })(),
    );
  },

  // ============ HTTP：鉴权 + 仪表盘 + API ============

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 仪表盘 HTML 始终返回（客户端做登录门禁，保护的是数据 API）
    if (url.pathname === "/") {
      return new Response(dashboardHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 登录校验接口（不要求鉴权）
    if (url.pathname === "/api/login" && req.method === "POST") {
      if (!env.AUTH_PASSWORD) {
        return Response.json({ ok: true, noAuth: true });
      }
      const body = await req.json().catch(() => ({})) as { password?: string };
      return Response.json({ ok: body.password === env.AUTH_PASSWORD });
    }

    // —— 以下接口均需鉴权（cron 不走这里，不受影响）——
    if (!isAuthed(req, url, env)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    // 任务一：多账号用量
    if (url.pathname === "/api/usage") {
      const raw = await env.CONFIG_KV.get(KV_USAGE);
      if (!raw) return Response.json({ reports: [], alerts: [] });
      return Response.json(JSON.parse(raw));
    }

    // 任务二：最近一次结果
    if (url.pathname === "/api/task2/result") {
      const raw = await env.CONFIG_KV.get(KV_TASK2_RESULT);
      if (!raw) return Response.json({ finalLinesPreview: [], filterSummary: {} });
      return Response.json(JSON.parse(raw));
    }

    // 双任务运行状态
    if (url.pathname === "/api/status") {
      const raw = await env.CONFIG_KV.get(KV_LAST_RUN);
      return Response.json(raw ? JSON.parse(raw) : {});
    }

    // 手动触发：?task=1|2
    if (url.pathname === "/api/run" && req.method === "POST") {
      const task = url.searchParams.get("task");
      try {
        if (task === "1") {
          const { reports, alerts } = await runTask1(env);
          await recordRun(env, 1, true);
          return Response.json({ ok: true, task: 1, reports, alerts });
        }
        if (task === "2") {
          const result = await runTask2AndStore(env);
          await recordRun(env, 2, true);
          return Response.json({ ok: true, task: 2, result });
        }
        return Response.json({ ok: false, error: "missing or invalid ?task=1|2" }, { status: 400 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordRun(env, task === "1" || task === "2" ? Number(task) as 1 | 2 : 1, false, msg);
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

/** 鉴权：未配置 AUTH_PASSWORD 则放行；否则校验 Bearer 或 ?token= */
function isAuthed(req: Request, url: URL, env: Env): boolean {
  if (!env.AUTH_PASSWORD) return true;
  const auth = req.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ") && auth.slice(7) === env.AUTH_PASSWORD) return true;
  if (url.searchParams.get("token") === env.AUTH_PASSWORD) return true;
  return false;
}
