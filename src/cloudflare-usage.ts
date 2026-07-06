/**
 * Cloudflare 用量轮询模块
 *
 * 通过 Cloudflare Analytics GraphQL API 拉取当天（或当月）用量，
 * 结合 FREE_TIER_LIMITS 计算使用百分比。
 *
 * GraphQL 文档：
 *   https://developers.cloudflare.com/analytics/graphql-api/
 * 各数据集：
 *   - workersInvocationsAdaptive  : Worker 调用量
 *   - d1OperationsAdaptive        : D1 读/写行数
 *   - r2StorageAdaptiveGroups     : R2 操作量
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

/** 计算「当天」UTC 起止 */
function todayWindow(): { since: string; until: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { since: start.toISOString(), until: end.toISOString() };
}

/** 计算「当月」起止 */
function monthWindow(): { since: string; until: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { since: start.toISOString(), until: end.toISOString() };
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
async function fetchWorkerRequests(cfg: CfUsageConfig, since: string, until: string): Promise<number> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 100
          ) {
            sum { requests }
          }
        }
      }
    }
  `;
  const r = await gql<{ viewer: { accounts: Array<{ workersInvocationsAdaptive: Array<{ sum: { requests: number } }> }> } }>(
    cfg,
    query,
    { accountTag: cfg.accountId, since, until },
  );
  if (r.errors?.length) throw new Error(`workersInvocationsAdaptive: ${r.errors[0].message}`);
  const rows = r.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return rows.reduce((acc, row) => acc + (row.sum?.requests ?? 0), 0);
}

/** 拉取 D1 行读取/写入（当天） */
async function fetchD1Ops(
  cfg: CfUsageConfig,
  since: string,
  until: string,
): Promise<{ read: number; written: number }> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          d1OperationsAdaptive(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 100
          ) {
            sum {
              rowsRead
              rowsWritten
              queries
            }
          }
        }
      }
    }
  `;
  const r = await gql<{ viewer: { accounts: Array<{ d1OperationsAdaptive: Array<{ sum: { rowsRead: number; rowsWritten: number; queries: number } }> }> } }>(
    cfg,
    query,
    { accountTag: cfg.accountId, since, until },
  );
  // D1 数据集可能不存在/未启用，错误不致命，返回 0
  if (r.errors?.length) {
    console.warn("d1OperationsAdaptive error:", r.errors[0].message);
    return { read: 0, written: 0 };
  }
  const rows = r.data?.viewer?.accounts?.[0]?.d1OperationsAdaptive ?? [];
  return rows.reduce(
    (acc, row) => {
      acc.read += row.sum?.rowsRead ?? 0;
      acc.written += row.sum?.rowsWritten ?? 0;
      return acc;
    },
    { read: 0, written: 0 },
  );
}

/** 拉取 R2 Class A / Class B 操作量（当月） */
async function fetchR2Ops(
  cfg: CfUsageConfig,
  since: string,
  until: string,
): Promise<{ classA: number; classB: number }> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2StorageAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 100
          ) {
            sum {
              operationsClassA
              operationsClassB
            }
          }
        }
      }
    }
  `;
  const r = await gql<{ viewer: { accounts: Array<{ r2StorageAdaptiveGroups: Array<{ sum: { operationsClassA: number; operationsClassB: number } }> }> } }>(
    cfg,
    query,
    { accountTag: cfg.accountId, since, until },
  );
  if (r.errors?.length) {
    console.warn("r2StorageAdaptiveGroups error:", r.errors[0].message);
    return { classA: 0, classB: 0 };
  }
  const rows = r.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];
  return rows.reduce(
    (acc, row) => {
      acc.classA += row.sum?.operationsClassA ?? 0;
      acc.classB += row.sum?.operationsClassB ?? 0;
      return acc;
    },
    { classA: 0, classB: 0 },
  );
}

/**
 * 通用防御性 GraphQL 查询：拉取某数据集的 sum 指标。
 * 数据集不存在/未启用/字段名不符时返回 0，不抛错（与 D1/R2 错误处理一致）。
 */
async function fetchSumMetric(
  cfg: CfUsageConfig,
  dataset: string,
  sumField: string,
  since: string,
  until: string,
): Promise<number> {
  const query = `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          ${dataset}(
            filter: { datetime_geq: $since, datetime_leq: $until }
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
      cfg,
      query,
      { accountTag: cfg.accountId, since, until },
    );
    if (r.errors?.length) {
      console.warn(`${dataset} error:`, r.errors[0].message);
      return 0;
    }
    const rows = r.data?.viewer?.accounts?.[0]?.[dataset] ?? [];
    return rows.reduce((acc, row) => acc + (row.sum?.[sumField] ?? 0), 0);
  } catch (err) {
    console.warn(`${dataset} fetch failed:`, String(err));
    return 0;
  }
}

/** 拉取 KV 读/写/删/列表（当天）—— kvOperationsAdaptive */
async function fetchKvOps(
  cfg: CfUsageConfig,
  since: string,
  until: string,
): Promise<{ reads: number; writes: number; deletes: number; lists: number }> {
  const query = `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          kvOperationsAdaptive(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 100
          ) {
            sum {
              reads
              writes
              deletes
              lists
            }
          }
        }
      }
    }
  `;
  try {
    const r = await gql<{ viewer: { accounts: Array<{ kvOperationsAdaptive: Array<{ sum: { reads: number; writes: number; deletes: number; lists: number } }> }> } }>(
      cfg,
      query,
      { accountTag: cfg.accountId, since, until },
    );
    if (r.errors?.length) {
      console.warn("kvOperationsAdaptive error:", r.errors[0].message);
      return { reads: 0, writes: 0, deletes: 0, lists: 0 };
    }
    const rows = r.data?.viewer?.accounts?.[0]?.kvOperationsAdaptive ?? [];
    return rows.reduce(
      (acc, row) => {
        acc.reads += row.sum?.reads ?? 0;
        acc.writes += row.sum?.writes ?? 0;
        acc.deletes += row.sum?.deletes ?? 0;
        acc.lists += row.sum?.lists ?? 0;
        return acc;
      },
      { reads: 0, writes: 0, deletes: 0, lists: 0 },
    );
  } catch (err) {
    console.warn("kvOperationsAdaptive fetch failed:", String(err));
    return { reads: 0, writes: 0, deletes: 0, lists: 0 };
  }
}

function pct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.round((used / limit) * 10000) / 100;
}

function buildItem(
  key: string,
  used: number,
): UsageItem {
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

  // 并发拉取所有数据集（每个独立容错，单数据集失败不影响其它）
  const [
    workerReq, d1Ops, r2Ops, kvOps,
    pagesReq, aiNeurons, queuesOps, vecQueries, vecStored, zarazEvents,
  ] = await Promise.all([
    fetchWorkerRequests(cfg, day.since, day.until),
    fetchD1Ops(cfg, day.since, day.until),
    fetchR2Ops(cfg, month.since, month.until),
    fetchKvOps(cfg, day.since, day.until),
    // 以下用通用防御性查询：数据集不存在/未启用时返回 0
    fetchSumMetric(cfg, "pagesRequestsAdaptive", "requests", day.since, day.until),
    fetchSumMetric(cfg, "workersAiInvocationsAdaptive", "neurons", day.since, day.until),
    fetchSumMetric(cfg, "queuesOperationsAdaptive", "operations", day.since, day.until),
    fetchSumMetric(cfg, "vectorizeQueriesAdaptive", "queries", month.since, month.until),
    fetchSumMetric(cfg, "vectorizeStorageAdaptiveGroups", "storedVectors", month.since, month.until),
    fetchSumMetric(cfg, "zarazEventsAdaptive", "events", month.since, month.until),
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
          error: String(err),
        } as UsageReport & { error?: string };
      }
    }),
  );
}
