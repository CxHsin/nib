import { RETENTION_MS } from "./time.js";
import type { Store } from "./store.js";

interface TelegramResponse {
  ok?: unknown;
  description?: unknown;
  result?: { message_id?: unknown };
}

export class TelegramSender {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly store: Store,
  ) {}

  async deliverPending(): Promise<void> {
    this.store.cleanup(Date.now() - RETENTION_MS);
    for (const segment of this.store.listUnsentSegments()) {
      const prefix = segment.totalParts > 1 ? `[${segment.partIndex + 1}/${segment.totalParts}]\n` : "";
      this.store.markSegmentSending(segment.id);
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const messageId = await this.send(prefix + segment.body);
          this.store.markSegmentSent(segment.id, messageId);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
        }
      }
      if (lastError) throw lastError;
    }
  }

  private async send(text: string): Promise<string> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json() as TelegramResponse;
    if (!response.ok || payload.ok !== true) {
      throw new Error(`Telegram 发送失败：${String(payload.description ?? response.status)}`);
    }
    const messageId = payload.result?.message_id;
    if (typeof messageId !== "number" && typeof messageId !== "string") {
      throw new Error("Telegram 响应缺少 message_id");
    }
    return String(messageId);
  }
}
