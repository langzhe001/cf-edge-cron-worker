/**
 * 任务二批量检查源站接口：加密 + 鉴权 + 防重放
 *
 * 目的：突破 Cloudflare 单请求 subrequest 限制（免费版 50/请求）。
 *   原方案：N 个外链 → N 个 check subrequest（免费版 N≤47 顶天）
 *   新方案：N 个外链按 batch_size 分组 → ⌈N/batch_size⌉ 个 POST 本接口
 *          每个本接口请求是独立 Worker invocation，有独立 50 subrequest 预算，
 *          内部 check batch_size 条（≤40 安全），主请求 subrequest 从 N 降到 ⌈N/B⌉。
 *
 * 鉴权加密协议 v1（严丝合缝）：
 *   - AES-256-GCM 加密请求体（端到端防窥探，密文走 HTTPS 再加一层）
 *   - HMAC-SHA256 签名（防篡改、防伪造）
 *   - 时间戳 ±300s 窗口 + nonce KV 去重（防重放）
 *   - 密钥派生域分离：
 *       encKey = SHA-256(secret + "|enc")  → AES-GCM
 *       sigKey = secret                    → HMAC-SHA256
 *
 * 请求头：
 *   X-Auth-Version: 1
 *   X-Auth-Ts: <unix 秒>
 *   X-Auth-Nonce: <32 hex chars>  （16 字节随机；前 12 字节兼作 AES-GCM IV）
 *   X-Auth-Sig: <hex HMAC-SHA256(secret, "1\n"+ts+"\n"+nonce+"\n"+cipherB64)>
 *   Content-Type: text/plain;charset=utf-8
 * Body: base64( AES-256-GCM( JSON({items,checkBaseUrl,timeoutMs}) ) )
 *
 * 响应：明文 JSON { ok, results:[{item,link,normalized,timeout,error}] }
 *   （结果非敏感；源站接口由 worker self-call，HTTPS 已防传输篡改）
 */

import { checkOne, runWithConcurrency, BATCH_MAX_SIZE, type CheckOutcome } from "./task2";

const PROTOCOL_VERSION = "1";
const TS_WINDOW_SEC = 300;     // 时间戳容差窗口
const NONCE_TTL_SEC = 600;     // nonce 在 KV 中的存活（>TS_WINDOW 以覆盖边界）
const NONCE_KV_PREFIX = "bn:"; // nonce 去重 key 前缀

// ============ 密钥派生 ============

/** AES-256-GCM 密钥：由 secret 派生（域分离，避免同密钥多用途） */
async function deriveEncKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret + "|enc"));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** HMAC-SHA256 密钥：直接用 secret */
async function deriveSigKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

// ============ 编码 helpers ============

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** 定时安全比较（防侧信道） */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============ 加密 + 签名：构造请求 ============

interface BatchRequestPayload {
  items: string[];
  checkBaseUrl: string;
  timeoutMs: number;
}

/** 加密 payload 并生成签名头（调用方使用） */
export async function encryptAndSign(
  secret: string,
  payload: BatchRequestPayload,
): Promise<{ headers: Record<string, string>; body: string }> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = bufToHex(nonceBytes.buffer);
  const iv = nonceBytes.slice(0, 12); // AES-GCM 推荐 12 字节 IV

  const encKey = await deriveEncKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encKey, plaintext);
  const cipherB64 = bufToB64(cipherBuf);

  const sigKey = await deriveSigKey(secret);
  const sigInput = `${PROTOCOL_VERSION}\n${ts}\n${nonce}\n${cipherB64}`;
  const sigBuf = await crypto.subtle.sign("HMAC", sigKey, new TextEncoder().encode(sigInput));
  const sig = bufToHex(sigBuf);

  return {
    headers: {
      "X-Auth-Version": PROTOCOL_VERSION,
      "X-Auth-Ts": ts,
      "X-Auth-Nonce": nonce,
      "X-Auth-Sig": sig,
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: cipherB64,
  };
}

// ============ 源站接口：解密 + 验签 + 防重放 + 批量检查 ============

export interface BatchCheckEnv {
  TASK2_BATCH_SECRET?: string;
  CONFIG_KV: KVNamespace;
}

/** 处理 /api/task2/batch-check 请求（在 index.ts 路由中调用） */
export async function handleBatchCheck(req: Request, env: BatchCheckEnv): Promise<Response> {
  const secret = env.TASK2_BATCH_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: "TASK2_BATCH_SECRET not configured" }, { status: 500 });
  }

  // 1. 收集鉴权头
  const version = req.headers.get("X-Auth-Version");
  const ts = req.headers.get("X-Auth-Ts");
  const nonce = req.headers.get("X-Auth-Nonce");
  const sig = req.headers.get("X-Auth-Sig");
  if (!version || !ts || !nonce || !sig) {
    return Response.json({ ok: false, error: "missing auth headers" }, { status: 401 });
  }
  if (version !== PROTOCOL_VERSION) {
    return Response.json({ ok: false, error: "unsupported protocol version" }, { status: 401 });
  }
  // nonce 长度校验（32 hex = 16 字节）
  if (!/^[0-9a-f]{32}$/i.test(nonce)) {
    return Response.json({ ok: false, error: "invalid nonce format" }, { status: 401 });
  }

  // 2. 时间戳窗口校验（防长期重放）
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    return Response.json({ ok: false, error: "invalid ts" }, { status: 401 });
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > TS_WINDOW_SEC) {
    return Response.json({ ok: false, error: "ts out of window" }, { status: 401 });
  }

  // 3. 读取密文
  const cipherB64 = await req.text();

  // 4. 验签（HMAC-SHA256）
  const sigKey = await deriveSigKey(secret);
  const sigInput = `${PROTOCOL_VERSION}\n${ts}\n${nonce}\n${cipherB64}`;
  const expectedSigBuf = await crypto.subtle.sign("HMAC", sigKey, new TextEncoder().encode(sigInput));
  const expectedSig = bufToHex(expectedSigBuf);
  if (!timingSafeEqual(sig, expectedSig)) {
    return Response.json({ ok: false, error: "bad signature" }, { status: 401 });
  }

  // 5. nonce 防重放（fail-open：KV 异常时放行并记日志，避免 KV 抖动阻断主流程）
  const nonceKey = NONCE_KV_PREFIX + nonce;
  try {
    const existing = await env.CONFIG_KV.get(nonceKey);
    if (existing !== null) {
      return Response.json({ ok: false, error: "nonce replay" }, { status: 401 });
    }
    await env.CONFIG_KV.put(nonceKey, "1", { expirationTtl: NONCE_TTL_SEC });
  } catch (err) {
    console.warn("nonce KV check failed (fail-open):", String(err));
  }

  // 6. 解密请求体
  let payload: BatchRequestPayload;
  try {
    const encKey = await deriveEncKey(secret);
    const iv = hexToBytes(nonce).slice(0, 12);
    const cipherBuf = b64ToBuf(cipherB64);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encKey, cipherBuf);
    payload = JSON.parse(new TextDecoder().decode(plainBuf)) as BatchRequestPayload;
  } catch (err) {
    return Response.json({ ok: false, error: "decrypt failed: " + String(err) }, { status: 400 });
  }

  // 7. 参数校验
  if (!Array.isArray(payload.items) || typeof payload.checkBaseUrl !== "string") {
    return Response.json({ ok: false, error: "invalid payload" }, { status: 400 });
  }
  // 源站内部 subrequest 上限保护：单批 ≤ BATCH_MAX_SIZE（25）
  // 免费版 50 subrequest/invocation，每条 check 最坏 2 subrequest（5xx 重试），25×2=50 留余量
  if (payload.items.length > BATCH_MAX_SIZE) {
    return Response.json({ ok: false, error: `batch size exceeds ${BATCH_MAX_SIZE}` }, { status: 400 });
  }

  // 8. 执行批量检查（源站接口内部全并发；runWithConcurrency 内部会取 min(concurrency, items.length)）
  const tasks = payload.items.map(
    (item) => () => checkOne(payload.checkBaseUrl, item, payload.timeoutMs ?? 8000),
  );
  const results = await runWithConcurrency(tasks, payload.items.length);

  return Response.json({ ok: true, results });
}

// ============ 调用方：加密 POST 并解析响应 ============

/**
 * 调用源站批量检查接口。
 * 失败时抛错（由调用方决定降级策略）。
 */
export async function callBatchCheck(
  workerBaseUrl: string,
  secret: string,
  items: string[],
  checkBaseUrl: string,
  timeoutMs: number,
  requestTimeoutMs = 30000,
): Promise<CheckOutcome[]> {
  const payload: BatchRequestPayload = { items, checkBaseUrl, timeoutMs };
  const { headers, body } = await encryptAndSign(secret, payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const url = workerBaseUrl.replace(/\/+$/, "") + "/api/task2/batch-check";
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`batch-check HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { ok: boolean; results?: CheckOutcome[]; error?: string };
    if (!data.ok || !Array.isArray(data.results)) {
      throw new Error(`batch-check failed: ${data.error ?? "unknown"}`);
    }
    return data.results;
  } finally {
    clearTimeout(timer);
  }
}
