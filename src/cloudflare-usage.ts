/**
 * Cloudflare 用量轮询模块（对齐 CF-Workers-UsagePanel 数据模型）
 *
 * 五大类服务：Workers / Pages / KV / D1 / R2
 *
 * 数据集（参考项目验证过真实可用）：
 *   - workersInvocationsAdaptive                : Worker 调用量（filter: datetime_geq/leq，Time）
 *   - pagesFunctionsInvocationsAdaptiveGroups   : Pages Functions 调用（filter: datetime_geq/leq，Time）
 *   - d1AnalyticsAdaptiveGroups                 : D1 行读写（filter: date_geq/leq，Date）
 *   - kvOperationsAdaptiveGroups                : KV 操作（filter: date_geq/leq，Date）+ dimensions.actionType
 *   - r2OperationsAdaptiveGroups                : R2 操作（filter: datetime_geq/leq，Time）+ dimensions.actionType
 *
 * 限额周期：
 *   Workers/Pages/D1/KV → UTC 自然日
 *   R2 → 自然月
 *
 * GraphQL 文档：https://developers.cloudflare.com/analytics/graphql-api/
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

/** 格式化为 Cloudflare Date 类型（YYYY-MM-DD） */
function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 计算「当天」UTC 起止——Time 类型用 ISO，Date 类型用 YYYY-MM-DD */
function todayWindow(): { sinceIso: string; untilIso: string; sinceDate: string; untilDate: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    sinceIso: start.toISOString(),
    untilIso: now.toISOString(), // 含当日已过部分
    sinceDate: fmtDate(start),
    untilDate: fmtDate(start), // date_geq/leq 同一天
  };
}

/** 计算「当月」起止 */
function monthWindow(): { sinceIso: string; untilIso: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { sinceIso: start.toISOString(), untilIso: now.toISOString() };
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

/** 收集错误（不抛出，单个数据集失败不影响其它） */
function collectErrors(errors: Array<{ message: string }> | undefined): string | undefined {
  if (!errors?.length) return undefined;
  return errors.map((e) => e.message).join("; ");
}

/** 拉取 Worker 调用量（当天，datetime filter + Time 类型） */
async function fetchWorkerRequests(cfg: CfUsageConfig, sinceIso: string, untilIso: string): Promise<number> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 10000
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
    { accountTag: cfg.accountId, since: sinceIso, until: untilIso },
  );
  if (r.errors?.length) throw new Error(`workersInvocationsAdaptive: ${r.errors[0].message}`);
  const rows = r.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return rows.reduce((acc, row) => acc + (row.sum?.requests ?? 0), 0);
}

/** 拉取 Pages Functions 调用（当天，datetime filter + Time 类型） */
async function fetchPagesRequests(cfg: CfUsageConfig, sinceIso: string, untilIso: string): Promise<number> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          pagesFunctionsInvocationsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 1000
          ) {
            sum { requests }
          }
        }
      }
    }
  `;
  const r = await gql<{ viewer: { accounts: Array<{ pagesFunctionsInvocationsAdaptiveGroups: Array<{ sum: { requests: number } }> }> } }>(
    cfg,
    query,
    { accountTag: cfg.accountId, since: sinceIso, until: untilIso },
  );
  if (r.errors?.length) throw new Error(`pagesFunctionsInvocationsAdaptiveGroups: ${r.errors[0].message}`);
  const rows = r.data?.viewer?.accounts?.[0]?.pagesFunctionsInvocationsAdaptiveGroups ?? [];
  return rows.reduce((acc, row) => acc + (row.sum?.requests ?? 0), 0);
}

/** 拉取 D1 行读取/写入（当天，date filter + Date 类型） */
async function fetchD1Ops(
  cfg: CfUsageConfig,
  sinceDate: string,
  untilDate: string,
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
  const r = await gql<{ viewer: { accounts: Array<{ d1AnalyticsAdaptiveGroups: Array<{ sum: { rowsRead: number; rowsWritten: number } }> }> } }>(
    cfg,
    query,
    { accountTag: cfg.accountId, since: sinceDate, until: untilDate },
  );
  if (r.errors?.length) throw new Error(`d1AnalyticsAdaptiveGroups: ${r.errors[0].message}`);
  const rows = r.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  return rows.reduce(
    (acc, row) => {
      acc.read += row.sum?.rowsRead ?? 0;
      acc.written += row.sum?.rowsWritten ?? 0;
      return acc;
    },
    { read: 0, written: 0 },
  );
}

/** 拉取 KV 读/写/删/列表（当天，date filter + Date 类型，按 actionType 分类） */
async function fetchKvOps(
  cfg: CfUsageConfig,
  sinceDate: string,
  untilDate: string,
): Promise<{ reads: number; writes: number; deletes: number; lists: number }> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Date!, $until: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          kvOperationsAdaptiveGroups(
            filter: { date_geq: $since, date_leq: $until }
            limit: 10000
          ) {
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }
  `;
  const r = await gql<{ viewer: { accounts: Array<{ kvOperationsAdaptiveGroups: Array<{ sum: { requests: number }; dimensions: { actionType: string } }> }> } }>(
    cfg,
    query,
    { accountTag: cfg.accountId, since: sinceDate, until: untilDate },
  );
  if (r.errors?.length) throw new Error(`kvOperationsAdaptiveGroups: ${r.errors[0].message}`);
  const rows = r.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? [];
  const out = { reads: 0, writes: 0, deletes: 0, lists: 0 };
  for (const row of rows) {
    const n = row.sum?.requests ?? 0;
    const action = String(row.dimensions?.actionType ?? "").toLowerCase();
    if (action.includes("read") || action.includes("get")) out.reads += n;
    else if (action.includes("write") || action.includes("put")) out.writes += n;
    else if (action.includes("delete")) out.deletes += n;
    else if (action.includes("list")) out.lists += n;
  }
  return out;
}

/** R2 操作分类（对齐参考项目规范化动作名） */
const R2_CLASS_A = new Set([
  "listbuckets", "putbucket", "listobjects", "listobjectsv2", "putobject", "copyobject",
  "completemultipartupload", "createmultipartupload", "lifecyclestoragetiertransition",
  "listmultipartuploads", "uploadpart", "uploadpartcopy", "listparts",
  "putbucketencryption", "putbucketcors", "putbucketlifecycleconfiguration",
]);
const R2_CLASS_B = new Set([
  "headbucket", "headobject", "getobject", "usagesummary",
  "getbucketencryption", "getbucketlocation", "getbucketcors", "getbucketlifecycleconfiguration",
]);

/** 拉取 R2 Class A / Class B 操作量（当月，datetime filter + Time 类型，按 actionType 分类） */
async function fetchR2Ops(
  cfg: CfUsageConfig,
  sinceIso: string,
  untilIso: string,
): Promise<{ classA: number; classB: number }> {
  const query = /* graphql */ `
    query($accountTag: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(
            filter: { datetime_geq: $since, datetime_leq: $until }
            limit: 10000
          ) {
            sum { requests }
            dimensions { actionType actionStatus }
          }
        }
      }
    }
  `;
  const r = await gql<{ viewer: { accounts: Array<{ r2OperationsAdaptiveGroups: Array<{ sum: { requests: number }; dimensions: { actionType: string; actionStatus: string } }> }> } }>(
    cfg,
    query,
    { accountTag: cfg.accountId, since: sinceIso, until: untilIso },
  );
  if (r.errors?.length) throw new Error(`r2OperationsAdaptiveGroups: ${r.errors[0].message}`);
  const rows = r.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? [];
  const out = { classA: 0, classB: 0 };
  for (const row of rows) {
    // 仅统计成功的操作（对齐参考项目）
    if (String(row.dimensions?.actionStatus ?? "").toLowerCase() !== "success") continue;
    const n = row.sum?.requests ?? 0;
    const action = String(row.dimensions?.actionType ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (R2_CLASS_A.has(action)) out.classA += n;
    else if (R2_CLASS_B.has(action)) out.classB += n;
    // delete 类操作免费，不计入 Class A/B
  }
  return out;
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
  const datasetErrors: Record<string, string> = {};

  // 并发拉取所有数据集（每个独立容错，单数据集失败不影响其它）
  const [workerReq, pagesReq, d1Ops, kvOps, r2Ops] = await Promise.all([
    fetchWorkerRequests(cfg, day.sinceIso, day.untilIso).catch((e) => {
      datasetErrors["workersInvocationsAdaptive"] = String(e.message ?? e);
      return 0;
    }),
    fetchPagesRequests(cfg, day.sinceIso, day.untilIso).catch((e) => {
      datasetErrors["pagesFunctionsInvocationsAdaptiveGroups"] = String(e.message ?? e);
      return 0;
    }),
    fetchD1Ops(cfg, day.sinceDate, day.untilDate).catch((e) => {
      datasetErrors["d1AnalyticsAdaptiveGroups"] = String(e.message ?? e);
      return { read: 0, written: 0 };
    }),
    fetchKvOps(cfg, day.sinceDate, day.untilDate).catch((e) => {
      datasetErrors["kvOperationsAdaptiveGroups"] = String(e.message ?? e);
      return { reads: 0, writes: 0, deletes: 0, lists: 0 };
    }),
    fetchR2Ops(cfg, month.sinceIso, month.untilIso).catch((e) => {
      datasetErrors["r2OperationsAdaptiveGroups"] = String(e.message ?? e);
      return { classA: 0, classB: 0 };
    }),
  ]);

  const items: UsageItem[] = [
    buildItem("workers_requests", workerReq),
    buildItem("pages_requests", pagesReq),
    buildItem("kv_reads", kvOps.reads),
    buildItem("kv_writes", kvOps.writes),
    buildItem("kv_deletes", kvOps.deletes),
    buildItem("kv_list", kvOps.lists),
    buildItem("d1_rows_read", d1Ops.read),
    buildItem("d1_rows_written", d1Ops.written),
    buildItem("r2_class_a", r2Ops.classA),
    buildItem("r2_class_b", r2Ops.classB),
  ];

  return {
    generatedAt: new Date().toISOString(),
    accountId: cfg.accountId,
    accountName,
    since: day.sinceIso,
    until: day.untilIso,
    items,
    datasetErrors: Object.keys(datasetErrors).length > 0 ? datasetErrors : undefined,
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
