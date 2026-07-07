/**
 * 任务二：外链检查 + 纯净度过滤 + 拼接推送
 *
 * 流程：
 *   1. cron 触发 → runTask2
 *   2. fetch 外链列表 URL（env.TASK2_LIST_URL）→ 每行一个字符串
 *   3. 循环 GET 请求（url = env.TASK2_CHECK_BASE_URL + 每行字符串）
 *      返回 CheckSocks5 风格 JSON：{ link, exit:{ ip, is_datacenter, company.abuser_score, asn.abuser_score, location.country... } }
 *      性能优化：滑动窗口并发（非整批 Promise.all，快的先释放槽位）
 *   4. 获取国家 / ASN / ip 属性 / 纯净度（纯净度自行运算，复用 ip-info.ts）
 *   5. 过滤：超时 / error / 非住宅 IP / 纯净度 ∈ {轻微风险, 高风险, 极度危险}
 *   6. 拼接「国家[纯净度]$链接」
 *   7. fetch 另一组数据 URL（env.TASK2_EXTRA_DATA_URL）→ 每行一个字符串
 *   8. 二次拼接「另一组数据#链接」（另一组行数少于链接时循环复用，即 modulo）
 *   9. 最终数据每行一条 → POST 推送（env.TASK2_PUSH_URL）
 *
 * subrequest 优化说明：
 *   - 单次 invocation 默认最多 80 条外链 = 80 个 GET + 2 个 fetch（列表+extra）= 82 subrequests
 *   - Cloudflare 免费版单请求 subrequest 上限 50，付费版 1000
 *   - 若用免费版，请把 TASK2_MAX_ITEMS 调到 ≤ 40
 */

import {
  normalizeExitData,
  calculateExitRiskScore,
  getExitRiskMeta,
  extractIpAttributes,
  type IpapiRawResponse,
  type NormalizedExit,
  type IpAttributes,
  type RiskLevel,
} from "./ip-info";
import { callBatchCheck } from "./batch-check";

export interface Task2Env {
  TASK2_LIST_URL: string;
  TASK2_CHECK_BASE_URL: string;
  TASK2_EXTRA_DATA_URL: string;
  TASK2_PUSH_URL: string;
  TASK2_MAX_ITEMS?: string;
  TASK2_CONCURRENCY?: string;
  TASK2_TIMEOUT_MS?: string;
  /** 推送接口的 auth cookie 值（拼到 Cookie: auth=<值>） */
  edtcookie?: string;
  // —— 批量检查模式（突破 subrequest 限制）——
  /** Worker 自身公网 URL（如 https://xxx.workers.dev），用于 self-call 批量接口。未配置则降级为直连模式 */
  WORKER_BASE_URL?: string;
  /** 批量接口加密鉴权密钥（secret put 注入）。未配置则降级为直连模式 */
  TASK2_BATCH_SECRET?: string;
  /** 每批外链数（默认 = concurrency，≤40 安全） */
  TASK2_BATCH_SIZE?: string;
  /** 同时进行的批次数（默认 4） */
  TASK2_BATCH_CONCURRENCY?: string;
}

export interface Task2Result {
  generatedAt: string;
  listCount: number;       // 外链列表总数
  checkedCount: number;    // 实际发起检查数
  filteredCount: number;   // 过滤后符合要求数
  finalCount: number;      // 最终拼接推送数
  pushed: boolean;
  pushStatus: string;
  /** 是否启用了批量检查模式（突破 subrequest 限制） */
  batchMode: boolean;
  /** 过滤原因统计 */
  filterSummary: {
    timeout: number;
    error: number;
    nonResidential: number;
    badPurity: number;
    ok: number;
  };
  /** 最终推送的每行数据（最多预览 50 条） */
  finalLinesPreview: string[];
}

/** 单条检查的原始结果 */
export interface CheckOutcome {
  item: string;
  link: string;
  normalized: NormalizedExit | null;
  timeout: boolean;
  error: string;
}

/** 默认上限提高至 200：批量模式下主请求 subrequest = ⌈200/20⌉+3 = 13，远低于 50 */
const DEFAULT_MAX_ITEMS = 200;
// 默认并发提高到 20（Cloudflare 单 Worker 内 fetch 并发不受 CPU 限制，受 subrequest 总数限制）
const DEFAULT_CONCURRENCY = 20;
// 并发上限放到 50（免费版 subrequest 上限 50，付费版 1000；若用免费版请把 MAX_ITEMS 调小）
const MAX_CONCURRENCY = 50;
const DEFAULT_TIMEOUT_MS = 8000;
// 单条 check 失败时的轻量重试次数（仅对网络错误/5xx，超时不重试）
const CHECK_RETRIES = 1;
/**
 * 源站接口单批硬上限：免费版 50 subrequest/invocation，每条 check 最坏 2 subrequest（5xx 重试），
 * 故 50/2=25，取 25 留余量。与 batch-check.ts 的硬上限保持一致。
 */
export const BATCH_MAX_SIZE = 25;

// ============ 工具函数 ============

/** fetch 纯文本（外链列表 / 另一组数据） */
async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 按行分割文本，过滤空行/注释，截断到 max */
function parseLines(raw: string, max: number): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    if (seen.has(s)) continue; // 去重，性能优化
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** 单条外链检查：GET base+item → 解析 JSON → 归一化（含 1 次轻量重试） */
export async function checkOne(
  baseUrl: string,
  item: string,
  timeoutMs: number,
): Promise<CheckOutcome> {
  const url = baseUrl + encodeURIComponent(item);
  const headers = { Accept: "application/json", "User-Agent": "cf-edge-cron-worker/1.0 task2" };

  for (let attempt = 0; attempt <= CHECK_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers, redirect: "manual" });
      const text = await res.text();
      if (!res.ok) {
        // 5xx 可重试；4xx 直接放弃
        if (res.status >= 500 && attempt < CHECK_RETRIES) { clearTimeout(timer); continue; }
        return { item, link: item, normalized: null, timeout: false, error: `HTTP ${res.status}` };
      }
      let json: { link?: string; exit?: IpapiRawResponse } & IpapiRawResponse;
      try {
        json = JSON.parse(text);
      } catch {
        return { item, link: item, normalized: null, timeout: false, error: "invalid json" };
      }
      // CheckSocks5 风格：{ link, exit:{...} }；兼容扁平结构
      const link = json.link ?? item;
      const exitRaw: IpapiRawResponse = (json.exit && typeof json.exit === "object") ? json.exit : json;
      const normalized = normalizeExitData(exitRaw);
      return { item, link, normalized, timeout: false, error: "" };
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      // 超时不重试（已等 timeoutMs，再等会拖垮整体）；网络错误可重试 1 次
      if (aborted || attempt >= CHECK_RETRIES) {
        return { item, link: item, normalized: null, timeout: aborted, error: aborted ? "" : String(err) };
      }
      // 网络错误：重试
    } finally {
      clearTimeout(timer);
    }
  }
  // 理论不可达（重试用尽在上面 catch 返回）
  return { item, link: item, normalized: null, timeout: false, error: "exhausted retries" };
}

/** 滑动窗口并发执行器（性能优化：快的请求先释放槽位，非整批等待） */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, tasks.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= tasks.length) return;
          results[i] = await tasks[i]();
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/**
 * 住宅 IP 判定：
 *   1. 所有风险标志为 false（is_datacenter/proxy/vpn/tor/crawler/abuser/bogon）
 *      is_mobile/is_satellite 视为中性可接受
 *   2. company.type 与 asn.type 都为 "isp"（Internet Service Provider）
 */
function isResidential(attrs: IpAttributes, normalized: NormalizedExit): boolean {
  const riskFree =
    !attrs.is_datacenter &&
    !attrs.is_proxy &&
    !attrs.is_vpn &&
    !attrs.is_tor &&
    !attrs.is_crawler &&
    !attrs.is_abuser &&
    !attrs.is_bogon;
  if (!riskFree) return false;
  const companyType = String(normalized.company?.type ?? "").toLowerCase();
  const asnType = String(normalized.asnInfo?.type ?? "").toLowerCase();
  return companyType === "isp" && asnType === "isp";
}

/** 需要排除的纯净度等级 */
const BAD_PURITY_LEVELS: ReadonlySet<RiskLevel> = new Set(["elevated", "high", "critical"]);

// ============ 主入口 ============

export async function runTask2(env: Task2Env): Promise<Task2Result> {
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, parseInt(env.TASK2_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY));
  const timeoutMs = Math.max(1000, parseInt(env.TASK2_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS);

  // 批量模式 vs 直连模式
  // 批量模式：N 个外链 → ⌈N/batchSize⌉ 个 POST 源站接口，主请求 subrequest = ⌈N/B⌉+3
  // 直连模式：每个外链单独 check，subrequest = N+3，免费版 N≤20 安全（含重试 2x：1+N*2+1+1≤50）
  const batchMode = !!(env.WORKER_BASE_URL && env.TASK2_BATCH_SECRET);
  // 直连模式硬性降额：免费版 50 subrequest 上限，留重试余量
  //   1(list) + N*2(重试最坏) + 1(extra) + 1(push) ≤ 50 → N ≤ 23，取 20 留余量
  const DIRECT_MODE_MAX = 20;
  const rawMaxItems = Math.max(1, parseInt(env.TASK2_MAX_ITEMS ?? String(DEFAULT_MAX_ITEMS), 10) || DEFAULT_MAX_ITEMS);
  const maxItems = batchMode ? rawMaxItems : Math.min(rawMaxItems, DIRECT_MODE_MAX);
  if (!batchMode && rawMaxItems > DIRECT_MODE_MAX) {
    console.warn(`task2 direct mode: maxItems ${rawMaxItems} capped to ${DIRECT_MODE_MAX} (free plan 50 subrequest limit). Configure WORKER_BASE_URL + TASK2_BATCH_SECRET to enable batch mode for more items.`);
  }

  const filterSummary = { timeout: 0, error: 0, nonResidential: 0, badPurity: 0, ok: 0 };

  // 步骤 2：fetch 外链列表
  const listText = await fetchText(env.TASK2_LIST_URL);
  const items = parseLines(listText, maxItems);
  const listCount = items.length;

  // 步骤 3：并发检查
  let outcomes: CheckOutcome[];
  if (batchMode) {
    // 批量模式：N 个外链 → ⌈N/batchSize⌉ 个 POST 源站接口
    // 每个源站接口请求是独立 invocation，有独立 50 subrequest 预算
    const batchSize = Math.max(1, Math.min(BATCH_MAX_SIZE, parseInt(env.TASK2_BATCH_SIZE ?? String(concurrency), 10) || concurrency));
    const batchConcurrency = Math.max(1, parseInt(env.TASK2_BATCH_CONCURRENCY ?? "4", 10) || 4);
    // 按 batchSize 切片
    const batches: string[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    const batchTasks = batches.map(
      (batch) => () => callBatchCheck(env.WORKER_BASE_URL!, env.TASK2_BATCH_SECRET!, batch, env.TASK2_CHECK_BASE_URL, timeoutMs),
    );
    const batchResults = await runWithConcurrency(batchTasks, batchConcurrency);
    outcomes = batchResults.flat();
  } else {
    const tasks = items.map((item) => () => checkOne(env.TASK2_CHECK_BASE_URL, item, timeoutMs));
    outcomes = await runWithConcurrency(tasks, concurrency);
  }
  const checkedCount = outcomes.length;

  // 步骤 4-6：过滤 + 拼接「国家[纯净度]$链接」
  const joined: string[] = [];
  for (const o of outcomes) {
    if (o.timeout) { filterSummary.timeout++; continue; }
    if (o.error) { filterSummary.error++; continue; }
    if (!o.normalized) { filterSummary.error++; continue; }

    const attrs = extractIpAttributes(o.normalized);
    if (!isResidential(attrs, o.normalized)) { filterSummary.nonResidential++; continue; }

    const score = calculateExitRiskScore(o.normalized);
    const meta = getExitRiskMeta(score);
    if (BAD_PURITY_LEVELS.has(meta.level)) { filterSummary.badPurity++; continue; }

    // 国家：优先国家名，回退国家代码
    const country = String(o.normalized.country || o.normalized.countryCode || "未知");
    // 纯净度文案：用等级标签（极度纯净/纯净/未知），简洁
    const purity = meta.label;
    joined.push(`${country}[${purity}]$${o.link}`);
    filterSummary.ok++;
  }
  const filteredCount = joined.length;

  // 步骤 7：fetch 另一组数据
  let extra: string[] = [];
  try {
    const extraText = await fetchText(env.TASK2_EXTRA_DATA_URL);
    extra = parseLines(extraText, maxItems);
  } catch (err) {
    console.warn("fetch extra data failed:", String(err));
  }

  // 步骤 8：二次拼接「另一组数据#链接」（extra 行数少时循环复用）
  const finalLines: string[] = extra.length
    ? joined.map((j, i) => `${extra[i % extra.length]}#${j}`)
    : joined;
  const finalCount = finalLines.length;

  // 步骤 9：每行一条 → POST 推送
  let pushed = false;
  let pushStatus: string;
  if (!env.TASK2_PUSH_URL) {
    pushStatus = "skipped (TASK2_PUSH_URL not set)";
  } else if (finalCount === 0) {
    pushStatus = "skipped (no data after filter)";
  } else {
    pushStatus = "";
    try {
      const res = await fetch(env.TASK2_PUSH_URL, {
        method: "POST",
        headers: {
"Content-Type": "text/plain;charset=utf-8",
"X-Report-Type": "task2" ,
"Cookie": "auth=" + env.edtcookie,
"sec-ch-ua-platform": "Android",
"user-agent": "Mozilla/5.0 (Linux; Android 16; PJV110 Build/BP2A.250605.015) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.159 Mobile Safari/537.36",
"sec-ch-ua-mobile": "?1",
"accept": "*/*",
"x-requested-with": "mark.via",
"sec-fetch-site": "same-origin",
"sec-fetch-mode": "cors"
},
        body: finalLines.join("\n"),
      });
      pushed = res.ok;
      pushStatus = pushed ? `ok (${finalCount} lines)` : `HTTP ${res.status}`;
    } catch (err) {
      pushStatus = `error: ${String(err)}`;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    listCount,
    checkedCount,
    filteredCount,
    finalCount,
    pushed,
    pushStatus,
    batchMode,
    filterSummary,
    finalLinesPreview: finalLines.slice(0, 50),
  };
}
