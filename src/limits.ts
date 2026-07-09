/**
 * Cloudflare 免费版额度定义（对齐 CF-Workers-UsagePanel 数据模型）
 *
 * 五大类服务：Workers / Pages / KV / D1 / R2
 * 来源：https://developers.cloudflare.com/workers/platform/limits/
 *       https://developers.cloudflare.com/d1/platform/limits/
 *       https://developers.cloudflare.com/kv/platform/pricing/
 *       https://developers.cloudflare.com/pages/platform/limits/
 *       https://developers.cloudflare.com/r2/platform/pricing/
 *
 * 限额周期：
 *   Workers / Pages 请求数、D1 / KV 操作 → UTC 自然日
 *   R2 操作 → 自然月
 *   存储指标 → 最近一次快照
 */
export interface QuotaLimit {
  /** 资源名称 */
  name: string;
  /** 免费版上限 */
  limit: number;
  /** 周期：daily / monthly */
  period: "daily" | "monthly";
  /** 单位 */
  unit: string;
}

export const FREE_TIER_LIMITS: Record<string, QuotaLimit> = {
  // —— Workers（按日）——
  workers_requests: {
    name: "Workers 调用量",
    limit: 100_000,
    period: "daily",
    unit: "requests",
  },
  // —— Pages（按日）——
  pages_requests: {
    name: "Pages Functions 调用",
    limit: 100_000,
    period: "daily",
    unit: "requests",
  },
  // —— KV（按日）——
  kv_reads: {
    name: "KV 读取",
    limit: 100_000,
    period: "daily",
    unit: "reads",
  },
  kv_writes: {
    name: "KV 写入",
    limit: 1_000,
    period: "daily",
    unit: "writes",
  },
  kv_deletes: {
    name: "KV 删除",
    limit: 1_000,
    period: "daily",
    unit: "deletes",
  },
  kv_list: {
    name: "KV 列表",
    limit: 1_000,
    period: "daily",
    unit: "lists",
  },
  // —— D1（按日）——
  d1_rows_read: {
    name: "D1 行读取",
    limit: 5_000_000,
    period: "daily",
    unit: "rows",
  },
  d1_rows_written: {
    name: "D1 行写入",
    limit: 100_000,
    period: "daily",
    unit: "rows",
  },
  // —— R2（按月）——
  r2_class_a: {
    name: "R2 Class A 操作",
    limit: 1_000_000,
    period: "monthly",
    unit: "ops",
  },
  r2_class_b: {
    name: "R2 Class B 操作",
    limit: 10_000_000,
    period: "monthly",
    unit: "ops",
  },
};

export interface UsageItem {
  key: string;
  name: string;
  used: number;
  limit: number;
  period: "daily" | "monthly";
  unit: string;
  /** 使用百分比 0~100 */
  percent: number;
}

export interface UsageReport {
  generatedAt: string;
  accountId: string;
  /** 账号别名（多账号场景用于区分） */
  accountName?: string;
  /** 周期起止（ISO） */
  since: string;
  until: string;
  items: UsageItem[];
  /** 各数据集的 GraphQL 错误（key=数据集名，value=错误信息；用于面板展示为何某项为 0） */
  datasetErrors?: Record<string, string>;
}
