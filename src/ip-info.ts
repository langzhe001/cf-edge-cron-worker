/**
 * IP 信息查询与纯净度评估模块（功能 2）
 *
 * 逻辑提取自 https://github.com/cmliu/CF-Workers-CheckSocks5 的 _worker.js 前端代码：
 *   - normalizeExitData()    原始 ipapi.is 响应 → 归一化结构
 *   - calculateExitRiskScore() 纯净度评分
 *   - getExitRiskMeta()      纯净度等级/文案
 *   - formatExitLocation()   国家/城市
 *   - formatExitAsnDetail()  ASN/组织
 *   - renderExitDetailPanel() IP 属性（is_datacenter 等）
 *
 * 与原项目不同：原项目通过 SOCKS5/HTTP 代理隧道访问 api.ipapi.is 以获取「代理出口 IP」信息；
 * 本模块直接通过 fetch 访问 ipapi.is（?q=ip）查询指定 IP，用于在定时任务中批量评估
 * 外部链接解析出的 IP / 配置的 IP 列表的纯净度。
 *
 * ipapi.is 文档：https://api.ipapi.is/?q=8.8.8.8
 */

// ============ ipapi.is 原始响应类型 ============

interface IpapiAsn {
  asn?: number;
  abuser_score?: string;
  route?: string;
  descr?: string;
  country?: string;
  active?: boolean;
  org?: string;
  domain?: string;
  abuse?: string;
  type?: string;
  updated?: string;
  rir?: string;
  whois?: string;
}

interface IpapiCompany {
  name?: string;
  abuser_score?: string;
  domain?: string;
  type?: string;
  network?: string;
  whois?: string;
}

interface IpapiDatacenter {
  network?: string;
  datacenter?: string;
  domain?: string;
}

interface IpapiLocation {
  is_eu_member?: boolean;
  calling_code?: string;
  currency_code?: string;
  continent?: string;
  country?: string;
  country_code?: string;
  state?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  zip?: string;
  timezone?: string;
  local_time?: string;
}

/** ipapi.is 原始响应（exit 数据） */
export interface IpapiRawResponse {
  ip?: string;
  rir?: string;
  is_bogon?: boolean;
  is_mobile?: boolean;
  is_satellite?: boolean;
  is_crawler?: boolean;
  is_datacenter?: boolean;
  is_tor?: boolean;
  is_proxy?: boolean;
  is_vpn?: boolean;
  is_abuser?: boolean;
  datacenter?: IpapiDatacenter;
  company?: IpapiCompany;
  abuse?: { name?: string; address?: string; email?: string; phone?: string };
  asn?: IpapiAsn;
  location?: IpapiLocation;
  elapsed_ms?: number;
  timestamp?: string;
  // —— 以下是 normalizeExitData 的防御性 fallback 字段（兼容其它 IP API / cf 对象）——
  asOrganization?: string;
  org?: string;
  continent?: string;
  country?: string;
  countryCode?: string;
  country_code?: string;
  countryName?: string;
  countryIsoCode?: string;
  region?: string;
  regionName?: string;
  regionCode?: string;
  city?: string;
  postalCode?: string;
  timezone?: string;
  loc?: string;
  latitude?: number;
  longitude?: number;
  ipType?: string;
}

// ============ 归一化结构 ============

export interface NormalizedExit {
  ip: string;
  ipType: string;
  asn: number | string;
  asnInfo: IpapiAsn;
  asOrganization: string;
  org: string;
  continent: string;
  country: string;
  countryCode: string;
  country_code: string;
  countryName: string;
  region: string;
  city: string;
  postalCode: string;
  timezone: string;
  loc: string;
  latitude: number | string;
  longitude: number | string;
  /** 原始 is_* 标志透传 */
  is_bogon?: boolean;
  is_mobile?: boolean;
  is_satellite?: boolean;
  is_crawler?: boolean;
  is_datacenter?: boolean;
  is_tor?: boolean;
  is_proxy?: boolean;
  is_vpn?: boolean;
  is_abuser?: boolean;
  company?: IpapiCompany;
  datacenter?: IpapiDatacenter;
  rir?: string;
}

/** 纯净度等级 */
export type RiskLevel = "verylow" | "low" | "elevated" | "high" | "critical" | "unknown";

export interface RiskMeta {
  level: RiskLevel;
  /** 中文等级标签：极度纯净/纯净/轻微风险/高风险/极度危险/未知 */
  label: string;
  /** 百分比文案，如 "0.25% 纯净" */
  text: string;
  /** 0~1 评分（null 表示未知） */
  score: number | null;
  /** 0~100 百分比 */
  percentage: number | null;
}

/** IP 属性集合（安全检测项） */
export interface IpAttributes {
  is_datacenter: boolean;
  is_proxy: boolean;
  is_vpn: boolean;
  is_tor: boolean;
  is_crawler: boolean;
  is_mobile: boolean;
  is_satellite: boolean;
  is_abuser: boolean;
  is_bogon: boolean;
}

/** 单条 IP 查询结果 */
export interface IpInfoResult {
  query: string;
  success: boolean;
  ip: string | null;
  country: string;
  countryCode: string;
  city: string;
  region: string;
  asn: string;
  asnOrg: string;
  asnRoute: string;
  attributes: IpAttributes;
  risk: RiskMeta;
  raw?: NormalizedExit;
  error?: string;
}

// ============ 工具函数（移植自 _worker.js 前端） ============

/** 取第一个非空值（移植自 firstNonEmpty） */
function firstNonEmpty(...values: unknown[]): unknown {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return value;
  }
  return "";
}

/**
 * 解析 abuser_score 字段。
 * ipapi.is 返回形如 "0.01 (Elevated)"，Number.parseFloat 会取前导数字部分。
 */
function parseAbuseScore(value: unknown): number | null {
  const score = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(score) ? score : null;
}

/**
 * 归一化 ipapi.is 响应。
 * 移植自 _worker.js normalizeExitData()（L6651）。
 */
export function normalizeExitData(exit: IpapiRawResponse | null | undefined): NormalizedExit | null {
  if (!exit || typeof exit !== "object") return null;

  const location = exit.location && typeof exit.location === "object" ? exit.location : {};
  const asnInfo = exit.asn && typeof exit.asn === "object" ? exit.asn : {};
  const company = exit.company && typeof exit.company === "object" ? exit.company : {};

  const latitude = firstNonEmpty(exit.latitude, (location as IpapiLocation).latitude);
  const longitude = firstNonEmpty(exit.longitude, (location as IpapiLocation).longitude);
  const loc = firstNonEmpty(
    exit.loc,
    latitude !== "" && longitude !== "" ? String(latitude) + "," + String(longitude) : "",
  );

  // 原始 exit.asn 是对象，故取 asnInfo.asn 作为编号
  const asn = firstNonEmpty(typeof exit.asn === "object" ? "" : exit.asn, (asnInfo as IpapiAsn).asn);
  const asOrganization = firstNonEmpty(
    exit.asOrganization,
    exit.org,
    (asnInfo as IpapiAsn).org,
    (asnInfo as IpapiAsn).descr,
    company.name,
  );

  let countryCode = firstNonEmpty(
    exit.countryCode,
    exit.country_code,
    (location as IpapiLocation).country_code,
    (asnInfo as IpapiAsn).country,
  );
  if (/^[a-z]{2}$/i.test(String(countryCode ?? "").trim())) {
    countryCode = String(countryCode).trim().toUpperCase();
  }
  const countryName = firstNonEmpty(exit.countryName, (location as IpapiLocation).country);
  const ip = firstNonEmpty(exit.ip) as string;

  return {
    ...exit,
    ip: ip as string,
    ipType: firstNonEmpty(exit.ipType, ip && String(ip).includes(":") ? "ipv6" : ip ? "ipv4" : "") as string,
    asn: asn as number | string,
    asnInfo: asnInfo as IpapiAsn,
    asOrganization: asOrganization as string,
    org: firstNonEmpty(exit.org, asn ? "AS" + asn + (asOrganization ? " " + asOrganization : "") : asOrganization) as string,
    continent: firstNonEmpty(exit.continent, (location as IpapiLocation).continent) as string,
    country: firstNonEmpty(exit.country, countryCode, countryName) as string,
    countryCode: countryCode as string,
    country_code: countryCode as string,
    countryName: countryName as string,
    region: firstNonEmpty(exit.region, exit.regionName, (location as IpapiLocation).state) as string,
    city: firstNonEmpty(exit.city, (location as IpapiLocation).city) as string,
    postalCode: firstNonEmpty(exit.postalCode, (location as IpapiLocation).zip) as string,
    timezone: firstNonEmpty(exit.timezone, (location as IpapiLocation).timezone) as string,
    loc: loc as string,
    latitude: latitude as number | string,
    longitude: longitude as number | string,
  } as NormalizedExit;
}

/**
 * 计算纯净度评分。
 * 移植自 _worker.js calculateExitRiskScore()（L4801）。
 *
 * 公式：
 *   baseScore = ((company.abuser_score + asn.abuser_score) / 2) * 5
 *   riskCount = [is_crawler, is_proxy, is_vpn, is_tor, is_abuser] 中为 true 的个数
 *   finalScore = baseScore + riskCount * 0.15
 *   if is_bogon: finalScore += 1.0
 *   if baseScore==0 && riskCount==0 && !is_bogon: 返回 null（未知/无法评估）
 */
export function calculateExitRiskScore(exitData: NormalizedExit | null | undefined): number | null {
  if (!exitData) return null;
  const companyScore = parseAbuseScore(exitData.company?.abuser_score) ?? 0;
  const asnScore = parseAbuseScore(exitData.asnInfo?.abuser_score) ?? 0;
  const baseScore = ((companyScore + asnScore) / 2) * 5;
  const riskFlags = [
    exitData.is_crawler,
    exitData.is_proxy,
    exitData.is_vpn,
    exitData.is_tor,
    exitData.is_abuser,
  ];
  const riskCount = riskFlags.filter((flag) => flag === true).length;
  let finalScore = baseScore + riskCount * 0.15;
  if (exitData.is_bogon) finalScore += 1.0;
  if (baseScore === 0 && riskCount === 0 && !exitData.is_bogon) return null;
  return finalScore;
}

/**
 * 纯净度等级元信息。
 * 移植自 _worker.js getExitRiskMeta()（L4820）。
 */
export function getExitRiskMeta(score: number | null | undefined): RiskMeta {
  if (score === null || score === undefined) {
    return { level: "unknown", label: "未知", text: "未知", score: null, percentage: null };
  }
  const percentage = score * 100;
  if (percentage >= 100) {
    return { level: "critical", label: "极度危险", text: percentage.toFixed(2) + "% 极度危险", score, percentage };
  }
  if (percentage >= 20) {
    return { level: "high", label: "高风险", text: percentage.toFixed(2) + "% 高风险", score, percentage };
  }
  if (percentage >= 5) {
    return { level: "elevated", label: "轻微风险", text: percentage.toFixed(2) + "% 轻微风险", score, percentage };
  }
  if (percentage >= 0.25) {
    return { level: "low", label: "纯净", text: percentage.toFixed(2) + "% 纯净", score, percentage };
  }
  return { level: "verylow", label: "极度纯净", text: percentage.toFixed(2) + "% 极度纯净", score, percentage };
}

/** 提取 IP 属性集合（安全检测项，移植自 renderExitDetailPanel L4958） */
export function extractIpAttributes(exitData: NormalizedExit | null | undefined): IpAttributes {
  return {
    is_datacenter: Boolean(exitData?.is_datacenter),
    is_proxy: Boolean(exitData?.is_proxy),
    is_vpn: Boolean(exitData?.is_vpn),
    is_tor: Boolean(exitData?.is_tor),
    is_crawler: Boolean(exitData?.is_crawler),
    is_mobile: Boolean(exitData?.is_mobile),
    is_satellite: Boolean(exitData?.is_satellite),
    is_abuser: Boolean(exitData?.is_abuser),
    is_bogon: Boolean(exitData?.is_bogon),
  };
}

/** 国家/城市文案（移植自 formatExitLocation L6489） */
export function formatLocation(exitData: NormalizedExit | null | undefined): string {
  const country = String(
    firstNonEmpty(exitData?.country, exitData?.countryCode, exitData?.country_code, exitData?.countryName) ?? "",
  ).trim();
  const city = String(exitData?.city ?? "").trim();
  return [country, city].filter(Boolean).join(" · ");
}

/** ASN / 组织文案（移植自 formatExitAsnDetail L4898 + formatExitNetwork L6495） */
export function formatAsn(exitData: NormalizedExit | null | undefined): string {
  const asn = String(exitData?.asn ?? "").trim();
  const route = String(exitData?.asnInfo?.route ?? "").trim();
  const org = String(
    firstNonEmpty(exitData?.asnInfo?.org, exitData?.asOrganization) ?? "",
  ).trim();
  const parts = [asn ? "AS" + asn : "", route || org].filter(Boolean);
  return parts.join(" / ");
}

// ============ 查询入口 ============

const IPAPI_ENDPOINT = "https://api.ipapi.is/";

/** 单个 IP 查询（直接 fetch ipapi.is，?q=ip） */
export async function queryIpInfo(
  ip: string,
  timeoutMs = 8000,
): Promise<IpInfoResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${IPAPI_ENDPOINT}?q=${encodeURIComponent(ip)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "cf-edge-cron-worker/1.0 ip-info" },
    });
    if (!res.ok) {
      return { query: ip, success: false, ip: null, country: "", countryCode: "", city: "", region: "", asn: "", asnOrg: "", asnRoute: "", attributes: emptyAttrs(), risk: getExitRiskMeta(null), error: `HTTP ${res.status}` };
    }
    const raw = (await res.json()) as IpapiRawResponse;
    const normalized = normalizeExitData(raw);
    if (!normalized) {
      return { query: ip, success: false, ip: null, country: "", countryCode: "", city: "", region: "", asn: "", asnOrg: "", asnRoute: "", attributes: emptyAttrs(), risk: getExitRiskMeta(null), error: "invalid response" };
    }
    const score = calculateExitRiskScore(normalized);
    return {
      query: ip,
      success: true,
      ip: normalized.ip,
      country: formatLocation(normalized),
      countryCode: normalized.countryCode,
      city: normalized.city,
      region: normalized.region,
      asn: normalized.asn ? "AS" + normalized.asn : "",
      asnOrg: String(firstNonEmpty(normalized.asnInfo?.org, normalized.asOrganization) ?? ""),
      asnRoute: normalized.asnInfo?.route ?? "",
      attributes: extractIpAttributes(normalized),
      risk: getExitRiskMeta(score),
      raw: normalized,
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { query: ip, success: false, ip: null, country: "", countryCode: "", city: "", region: "", asn: "", asnOrg: "", asnRoute: "", attributes: emptyAttrs(), risk: getExitRiskMeta(null), error: aborted ? `timeout after ${timeoutMs}ms` : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function emptyAttrs(): IpAttributes {
  return {
    is_datacenter: false, is_proxy: false, is_vpn: false, is_tor: false,
    is_crawler: false, is_mobile: false, is_satellite: false, is_abuser: false, is_bogon: false,
  };
}

/** 限制并发的批量查询（复用 external-links 的滑动窗口模式） */
export async function queryIpInfoBatch(
  ips: string[],
  concurrency = 10,
  timeoutMs = 8000,
): Promise<IpInfoResult[]> {
  const results: IpInfoResult[] = new Array(ips.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, ips.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor++;
          if (i >= ips.length) return;
          results[i] = await queryIpInfo(ips[i], timeoutMs);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/** 从多行文本解析 IP 列表（每行一个 IP，最多 max 条） */
export function parseIpList(raw: string, max = 80): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const ip = line.trim();
    if (!ip || ip.startsWith("#")) continue;
    if (seen.has(ip)) continue;
    // 简单校验：IPv4 / IPv6
    if (!isLikelyIp(ip)) continue;
    seen.add(ip);
    out.push(ip);
    if (out.length >= max) break;
  }
  return out;
}

function isLikelyIp(s: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
  // IPv6（含 ::）
  if (/^[0-9a-fA-F:]+$/.test(s) && s.includes(":")) return true;
  return false;
}
