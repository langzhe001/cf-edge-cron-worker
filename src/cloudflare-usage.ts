/**
 * Cloudflare 用量轮询模块
 *
 * 通过 Cloudflare Analytics GraphQL API 拉取当天（或当月）用量，
 * 结合 FREE_TIER_LIMITS 计算使用百分比。
 *
 * 数据集（官方文档确认的真实名称）：
 *   - workersInvocationsAdaptive      : Worker 调用量（sum.requests）
 *   - d1AnalyticsAdaptiveGroups       : D1 读/写行数（sum.rowsRead/rowsWritten）
 *   - r2OperationsAdaptiveGroups      : R2 操作量（sum.requests + dimensions.actionType，按操作名归类 Class A/B）
 *   - kvOperationsAdaptiveGroups      : KV 操作量（sum.requests + dimensions.actionType）
 *   - 以下为推断数据集，失败返回 0 并在 datasetErrors 记录原因：
 *     pagesRequestsAdaptive / workersAiInvocationsAdaptive / queuesOperationsAdaptive
 *     / vectorizeQueriesAdaptive / vectorizeStorageAdaptiveGroups / zarazEventsAdaptive
 *
 * 关键：filter 使用 date_geq/date_leq + Date 类型（YYYY-MM-DD），非 datetime_geq/datetime_leq。
 * 所有数据集的 GraphQL 错误会被收集到 report.datasetErrors，供面板展示「为何为 0」。
 *
 * GraphQL 文档：https://developers.cloudflare.com/analytics/graphql-api/
 * R2:  https://developers.cloudflare.com/r2/reference/metrics-analytics/
 * D1:  https://developers.cloudflare.com/d1/observability/metrics-analytics/
 */

import { FREE_TIER_LIMITS, type UsageItem, type UsageReport } from "./limits";

const CF_GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

export interface CfUsageConfig {
  accountId: string;
  apiToken: string;
}

/** 多账号配置项 */
export interface CfAccount {
  id: string;
  token: string;
  /** 账号别名（用于面板展示与告警），缺省时用 id */
  name?: string;
}

/**
 * 计算「当天」UTC 起止（YYYY-MM-DD，Cloudflare adaptive 数据集 filter 使用 Date 类型）
 * 官方文档示例：filter: { date_geq: $start, date_leq: $end }，变量 "2024-07-15"
 */
function todayWindow(): { since: string; until: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { since: fmtDate(start), until: fmtDate(end) };
}

/** 计算「当月」起止（YYYY-MM-DD） */
function monthWindow(): { since: string; until: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { since: fmtDate(start), until: fmtDate(end) };
}

/** 格式化为 Cloudflare GraphQL Date 类型所需的 YYYY-MM-DD */
function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T = unknown>(
  cfg: CfUsageConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const res = await fetch(CF_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`CF GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as GraphQLResponse<T>;
}

/** 拉取 Worker 调用量（当天） */
async function fetchWorkerRequests(
  cfg: CfUsageConfig, since: string, until: string, errors: Record<string, string>,
): Promise<number> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Date!, $until: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            filter: { date_geq: $since, date_leq: $until }
            limit: 100
          ) {
            sum { requests }
          }
        }
      }
    }
  `;
  try {
    const r = await gql<{ viewer: { accounts: Array<{ workersInvocationsAdaptive: Array<{ sum: { requests: number } }> }> } }>(
      cfg, query, { accountTag: cfg.accountId, since, until },
    );
    if (r.errors?.length) { errors["workersInvocationsAdaptive"] = r.errors[0].message; return 0; }
    const rows = r.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    return rows.reduce((acc, row) => acc + (row.sum?.requests ?? 0), 0);
  } catch (err) { errors["workersInvocationsAdaptive"] = String(err); return 0; }
}

/** 拉取 D1 行读取/写入（当天）—— d1AnalyticsAdaptiveGroups */
async function fetchD1Ops(
  cfg: CfUsageConfig, since: string, until: string, errors: Record<string, string>,
): Promise<{ read: number; written: number }> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Date!, $until: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          d1AnalyticsAdaptiveGroups(
            filter: { date_geq: $since, date_leq: $until }
            limit: 10000
          ) {
            sum {
              rowsRead
              rowsWritten
            }
          }
        }
      }
    }
  `;
  try {
    const r = await gql<{ viewer: { accounts: Array<{ d1AnalyticsAdaptiveGroups: Array<{ sum: { rowsRead: number; rowsWritten: number } }> }> } }>(
      cfg, query, { accountTag: cfg.accountId, since, until },
    );
    if (r.errors?.length) { errors["d1AnalyticsAdaptiveGroups"] = r.errors[0].message; return { read: 0, written: 0 }; }
    const rows = r.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
    return rows.reduce(
      (acc, row) => {
        acc.read += row.sum?.rowsRead ?? 0;
        acc.written += row.sum?.rowsWritten ?? 0;
        return acc;
      },
      { read: 0, written: 0 },
    );
  } catch (err) { errors["d1AnalyticsAdaptiveGroups"] = String(err); return { read: 0, written: 0 }; }
}

/**
 * 拉取 R2 Class A / Class B 操作量（当月）—— r2OperationsAdaptiveGroups
 * 官方文档：该数据集 sum 只有 requests，按 dimensions.actionType 区分操作。
 * Class A（写入/列表/多段上传）：Put/Delete/List/Copy/Create/Upload/Complete/Abort
 * Class B（读取）：Get/Head
 */
async function fetchR2Ops(
  cfg: CfUsageConfig, since: string, until: string, errors: Record<string, string>,
): Promise<{ classA: number; classB: number }> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Date!, $until: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(
            filter: { date_geq: $since, date_leq: $until }
            limit: 10000
          ) {
            sum {
              requests
            }
            dimensions {
              actionType
            }
          }
        }
      }
    }
  `;
  try {
    const r = await gql<{ viewer: { accounts: Array<{ r2OperationsAdaptiveGroups: Array<{ sum: { requests: number }; dimensions: { actionType: string } }> }> } }>(
      cfg, query, { accountTag: cfg.accountId, since, until },
    );
    if (r.errors?.length) { errors["r2OperationsAdaptiveGroups"] = r.errors[0].message; return { classA: 0, classB: 0 }; }
    const rows = r.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? [];
    const out = { classA: 0, classB: 0 };
    for (const row of rows) {
      const n = row.sum?.requests ?? 0;
      const cls = r2ActionClass(row.dimensions?.actionType ?? "");
      if (cls === "A") out.classA += n;
      else if (cls === "B") out.classB += n;
    }
    return out;
  } catch (err) { errors["r2OperationsAdaptiveGroups"] = String(err); return { classA: 0, classB: 0 }; }
}

/** R2 操作按 actionType 归类 Class A / B */
function r2ActionClass(actionType: string): "A" | "B" | null {
  const a = String(actionType).toLowerCase();
  if (a.startsWith("get") || a.startsWith("head")) return "B";
  if (a.startsWith("put") || a.startsWith("delete") || a.startsWith("list") ||
      a.startsWith("copy") || a.startsWith("create") || a.startsWith("upload") ||
      a.startsWith("complete") || a.startsWith("abort")) return "A";
  return null;
}

/**
 * 通用防御性 GraphQL 查询：拉取某数据集的 sum 指标。
 * 数据集不存在/未启用/字段名不符时返回 0，并将错误写入 errors 供面板展示。
 */
async function fetchSumMetric(
  cfg: CfUsageConfig, dataset: string, sumField: string,
  since: string, until: string, errors: Record<string, string>,
): Promise<number> {
  const query = `
    query($accountTag: String!, $since: Date!, $until: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          ${dataset}(
            filter: { date_geq: $since, date_leq: $until }
            limit: 100
          ) {
            sum { ${sumField} }
          }
        }
      }
    }
  `;
  try {
    const r = await gql<{ viewer: { accounts: Array<Record<string, Array<{ sum: Record<string, number> }>>> } }>(
      cfg, query, { accountTag: cfg.accountId, since, until },
    );
    if (r.errors?.length) { errors[dataset] = r.errors[0].message; return 0; }
    const rows = r.data?.viewer?.accounts?.[0]?.[dataset] ?? [];
    return rows.reduce((acc, row) => acc + (row.sum?.[sumField] ?? 0), 0);
  } catch (err) { errors[dataset] = String(err); return 0; }
}

/**
 * 拉取 KV 读/写/删/列表（当天）—— kvOperationsAdaptiveGroups
 * 官方数据集 sum 只有 requests，按 dimensions.actionType 区分 read/write/delete/list。
 */
async function fetchKvOps(
  cfg: CfUsageConfig, since: string, until: string, errors: Record<string, string>,
): Promise<{ reads: number; writes: number; deletes: number; lists: number }> {
  const query = `
    query($accountTag: String!, $since: Date!, $until: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          kvOperationsAdaptiveGroups(
            filter: { date_geq: $since, date_leq: $until }
            limit: 10000
          ) {
            sum {
              requests
            }
            dimensions {
              actionType
            }
          }
        }
      }
    }
  `;
  try {
    const r = await gql<{ viewer: { accounts: Array<{ kvOperationsAdaptiveGroups: Array<{ sum: { requests: number }; dimensions: { actionType: string } }> }> } }>(
      cfg, query, { accountTag: cfg.accountId, since, until },
    );
    if (r.errors?.length) { errors["kvOperationsAdaptiveGroups"] = r.errors[0].message; return { reads: 0, writes: 0, deletes: 0, lists: 0 }; }
    const rows = r.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? [];
    const out = { reads: 0, writes: 0, deletes: 0, lists: 0 };
    for (const row of rows) {
      const n = row.sum?.requests ?? 0;
      const action = String(row.dimensions?.actionType ?? "").toLowerCase();
      if (action === "read" || action === "reads") out.reads += n;
      else if (action === "write" || action === "writes") out.writes += n;
      else if (action === "delete" || action === "deletes") out.deletes += n;
      else if (action === "list" || action === "lists") out.lists += n;
    }
    return out;
  } catch (err) { errors["kvOperationsAdaptiveGroups"] = String(err); return { reads: 0, writes: 0, deletes: 0, lists: 0 }; }
}

function pct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.round((used / limit) * 10000) / 100;
}

function buildItem(key: string, used: number): UsageItem {
  const def = FREE_TIER_LIMITS[key];
  return {
    key,
    name: def.name,
    used,
    limit: def.limit,
    period: def.period,
    unit: def.unit,
    percent: pct(used, def.limit),
  };
}

/** 主入口：拉取单账号用量并生成报告 */
export async function fetchCfUsageReport(cfg: CfUsageConfig, accountName?: string): Promise<UsageReport> {
  const day = todayWindow();
  const month = monthWindow();
  /** 收集各数据集的 GraphQL 错误（前端据此展示为何某项为 0） */
  const errors: Record<string, string> = {};

  // 并发拉取所有数据集（每个独立容错，单数据集失败不影响其它）
  const [
    workerReq, d1Ops, r2Ops, kvOps,
    pagesReq, aiNeurons, queuesOps, vecQueries, vecStored, zarazEvents,
  ] = await Promise.all([
    fetchWorkerRequests(cfg, day.since, day.until, errors),
    fetchD1Ops(cfg, day.since, day.until, errors),
    fetchR2Ops(cfg, month.since, month.until, errors),
    fetchKvOps(cfg, day.since, day.until, errors),
    fetchSumMetric(cfg, "pagesRequestsAdaptive", "requests", day.since, day.until, errors),
    fetchSumMetric(cfg, "workersAiInvocationsAdaptive", "neurons", day.since, day.until, errors),
    fetchSumMetric(cfg, "queuesOperationsAdaptive", "operations", day.since, day.until, errors),
    fetchSumMetric(cfg, "vectorizeQueriesAdaptive", "queries", month.since, month.until, errors),
    fetchSumMetric(cfg, "vectorizeStorageAdaptiveGroups", "storedVectors", month.since, month.until, errors),
    fetchSumMetric(cfg, "zarazEventsAdaptive", "events", month.since, month.until, errors),
  ]);

  const items: UsageItem[] = [
    // Workers
    buildItem("workers_requests", workerReq),
    buildItem("workers_cpu_ms", 0), // CPU 累计无直接 GraphQL，留 0
    // D1
    buildItem("d1_rows_read", d1Ops.read),
    buildItem("d1_rows_written", d1Ops.written),
    // R2
    buildItem("r2_class_a", r2Ops.classA),
    buildItem("r2_class_b", r2Ops.classB),
    // KV
    buildItem("kv_reads", kvOps.reads),
    buildItem("kv_writes", kvOps.writes),
    buildItem("kv_deletes", kvOps.deletes),
    buildItem("kv_list", kvOps.lists),
    // Pages
    buildItem("pages_builds", 0), // 构建次数无公开 GraphQL，留 0
    buildItem("pages_requests", pagesReq),
    // Workers AI
    buildItem("workers_ai_neurons", aiNeurons),
    // Queues
    buildItem("queues_operations", queuesOps),
    // Vectorize
    buildItem("vectorize_queries", vecQueries),
    buildItem("vectorize_stored", vecStored),
    // Zaraz
    buildItem("zaraz_events", zarazEvents),
  ];

  return {
    generatedAt: new Date().toISOString(),
    accountId: cfg.accountId,
    accountName,
    since: day.since,
    until: day.until,
    items,
    datasetErrors: errors,
  };
}

/**
 * 多账号并发拉取用量报告。
 * 单个账号失败不影响其它账号（返回该账号的错误占位报告）。
 */
export async function fetchAllAccountsUsage(accounts: CfAccount[]): Promise<UsageReport[]> {
  return Promise.all(
    accounts.map(async (acc) => {
      try {
        return await fetchCfUsageReport(
          { accountId: acc.id, apiToken: acc.token },
          acc.name ?? acc.id,
        );
      } catch (err) {
        // 失败占位：返回空 items + error 标记，避免整体崩溃
        return {
          generatedAt: new Date().toISOString(),
          accountId: acc.id,
          accountName: acc.name ?? acc.id,
          since: "",
          until: "",
          items: [],
          datasetErrors: {},
          error: String(err),
        } as UsageReport & { error?: string };
      }
    }),
  );
}
