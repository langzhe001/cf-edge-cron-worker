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

export interface Task2Env {
  TASK2_LIST_URL: string;
  TASK2_CHECK_BASE_URL: string;
  TASK2_EXTRA_DATA_URL: string;
  TASK2_PUSH_URL: string;
  TASK2_MAX_ITEMS?: string;
  TASK2_CONCURRENCY?: string;
  TASK2_TIMEOUT_MS?: string;
}

export interface Task2Result {
  generatedAt: string;
  listCount: number;       // 外链列表总数
  checkedCount: number;    // 实际发起检查数
  filteredCount: number;   // 过滤后符合要求数
  finalCount: number;      // 最终拼接推送数
  pushed: boolean;
  pushStatus: string;
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
interface CheckOutcome {
  item: string;
  link: string;
  normalized: NormalizedExit | null;
  timeout: boolean;
  error: string;
}

const DEFAULT_MAX_ITEMS = 80;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_TIMEOUT_MS = 8000;

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

/** 单条外链检查：GET base+item → 解析 JSON → 归一化 */
async function checkOne(
  baseUrl: string,
  item: string,
  timeoutMs: number,
): Promise<CheckOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // item 可能含特殊字符，统一 encode；baseUrl 末尾通常已带 ?proxy= 之类
    const url = baseUrl + encodeURIComponent(item);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "cf-edge-cron-worker/1.0 task2" },
    });
    const text = await res.text();
    if (!res.ok) {
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
    return {
      item,
      link: item,
      normalized: null,
      timeout: aborted,
      error: aborted ? "" : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 滑动窗口并发执行器（性能优化：快的请求先释放槽位，非整批等待） */
async function runWithConcurrency<T>(
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
  const maxItems = Math.max(1, parseInt(env.TASK2_MAX_ITEMS ?? String(DEFAULT_MAX_ITEMS), 10) || DEFAULT_MAX_ITEMS);
  const concurrency = Math.max(1, Math.min(20, parseInt(env.TASK2_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY));
  const timeoutMs = Math.max(1000, parseInt(env.TASK2_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS);

  const filterSummary = { timeout: 0, error: 0, nonResidential: 0, badPurity: 0, ok: 0 };

  // 步骤 2：fetch 外链列表
  const listText = await fetchText(env.TASK2_LIST_URL);
  const items = parseLines(listText, maxItems);
  const listCount = items.length;

  // 步骤 3：并发 GET 检查
  const tasks = items.map((item) => () => checkOne(env.TASK2_CHECK_BASE_URL, item, timeoutMs));
  const outcomes = await runWithConcurrency(tasks, concurrency);
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
  let pushStatus = "skipped (no push url)";
  if (env.TASK2_PUSH_URL && finalCount > 0) {
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
    filterSummary,
    finalLinesPreview: finalLines.slice(0, 50),
  };
}
