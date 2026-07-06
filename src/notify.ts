/**
 * Notifyx 消息推送模块
 *
 * API 格式（码达 Notifyx）：
 *   POST <webhook_url>
 *   Content-Type: application/json
 *   body: { "title": string(必填,≤100), "content": string, "summary"?: string }
 *
 * 文档：https://notifyx.cc/
 */

export interface NotifyxMessage {
  title: string;
  content: string;
  summary?: string;
}

/**
 * 推送 notifyx 消息。失败仅记录日志，不抛错（告警失败不应影响主流程）。
 */
export async function pushNotifyx(
  webhookUrl: string | undefined,
  message: NotifyxMessage,
): Promise<boolean> {
  if (!webhookUrl) return false;
  try {
    // title 截断到 100 字符（API 限制）
    const title = message.title.slice(0, 100);
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        content: message.content,
        summary: message.summary?.slice(0, 100),
      }),
    });
    if (!res.ok) {
      console.warn(`notifyx push HTTP ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("notifyx push failed:", String(err));
    return false;
  }
}
