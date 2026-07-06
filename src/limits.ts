/**
 * Cloudflare 免费版额度定义
 * 来源：https://developers.cloudflare.com/workers/platform/limits/
 *       https://developers.cloudflare.com/d1/platform/limits/
 *       https://developers.cloudflare.com/kv/platform/pricing/
 *       https://developers.cloudflare.com/pages/platform/limits/
 *
 * 注：限额以「每天」为周期（Pages builds 为每月），值为免费版上限。
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
  // —— Workers ——
  workers_requests: {
    name: "Workers 调用量",
    limit: 100_000,
    period: "daily",
    unit: "requests",
  },
  workers_cpu_ms: {
    name: "Workers CPU 时间",
    limit: 30_000, // 100k requests * 10ms（CPU 限制按请求计，这里按日累计粗算）
    period: "daily",
    unit: "ms",
  },
  // —— KV ——
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
  // —— D1 ——
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
  // —— R2 ——
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
  // —— Pages ——
  pages_builds: {
    name: "Pages 构建次数",
    limit: 500,
    period: "monthly",
    unit: "builds",
  },
  pages_requests: {
    name: "Pages Functions 调用",
    limit: 100_000,
    period: "daily",
    unit: "requests",
  },
  // —— Workers AI ——
  workers_ai_neurons: {
    name: "Workers AI 神经元",
    limit: 10_000,
    period: "daily",
    unit: "neurons",
  },
  // —— Queues ——
  queues_operations: {
    name: "Queues 操作",
    limit: 100_000,
    period: "daily",
    unit: "ops",
  },
  // —— Vectorize ——
  vectorize_queries: {
    name: "Vectorize 查询维度",
    limit: 30_000_000,
    period: "monthly",
    unit: "dims",
  },
  vectorize_stored: {
    name: "Vectorize 存储维度",
    limit: 5_000_000,
    period: "monthly",
    unit: "dims",
  },
  // —— Zaraz ——
  zaraz_events: {
    name: "Zaraz 事件",
    limit: 100_000,
    period: "monthly",
    unit: "events",
  },
  // —— Turnstile（免费不限量，仅占位展示）——
  // —— Email Routing（免费不限量）——
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
}
