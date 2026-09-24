import type { AppConfig, CapturedMessage } from "./types.js";
import type { Store } from "./store.js";
import type { WebReader } from "./web-reader.js";
import { RETENTION_MS } from "./time.js";
import { runChatAgent } from "./chat-agent.js";

export class ChatService {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private stopped = false;
  private active: AbortController | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly reader: WebReader,
    private readonly reply: (message: CapturedMessage, text: string) => Promise<string>,
    private readonly runAgent = runChatAgent,
  ) {}

  handle(message: CapturedMessage): Promise<void> {
    if (this.stopped || this.pending >= 5 || message.authorId !== this.config.ownerId ||
        !this.config.groupIds.has(message.groupId)) return Promise.resolve();
    if (!this.store.claimChatRequest(message)) return Promise.resolve();
    this.pending += 1;
    this.tail = this.tail.then(async () => {
      if (!this.stopped) await this.respond(message);
    }).catch(() => console.error("[QQ 对话] 请求处理失败"))
      .finally(() => { this.pending -= 1; });
    return this.tail;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.active?.abort();
    await this.tail;
  }

  private async respond(message: CapturedMessage): Promise<void> {
    if (message.text.length > 4000) {
      await this.reply(message, "消息过长，请缩短到 4000 字以内后再 @nib。");
      return;
    }
    const history = this.store.listChatTurns(message.groupId, message.authorId);
    this.store.saveChatTurn(message.groupId, message.authorId, {
      role: "user", text: message.text, createdAt: message.occurredAt,
    });
    const controller = new AbortController();
    this.active = controller;
    const timer = setTimeout(() => controller.abort(), 90_000);
    let answer: { text: string; expiresAt?: number };
    try {
      answer = await this.runAgent({
        store: this.store, webReader: this.reader, message, history,
        apiKey: this.config.deepseekApiKey, modelId: this.config.modelId,
        ...(this.config.tinyfishApiKey ? { tinyfishApiKey: this.config.tinyfishApiKey } : {}),
        maxToolCalls: this.config.maxAgentToolCalls, signal: controller.signal,
      });
      controller.signal.throwIfAborted();
    } catch (error) {
      const category = controller.signal.aborted ? "已取消或超时"
        : error instanceof Error && /402|Insufficient Balance/i.test(error.message) ? "模型余额不足（402）" : "模型或工具执行失败";
      const detail = error instanceof Error ? error.message : String(error);
      const safeDetail = [this.config.deepseekApiKey, this.config.telegramBotToken, this.config.napcatAccessToken, this.config.tinyfishApiKey]
        .filter((secret): secret is string => Boolean(secret))
        .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), detail)
        .replace(/[\r\n]+/g, " ").slice(0, 600);
      console.warn(`[QQ 对话] ${category}：${safeDetail}`);
      if (!this.stopped) await this.reply(message,
        controller.signal.aborted ? "这次处理超时了，请缩小问题范围后重试。" : "这次处理未完成，请稍后再试。");
      return;
    } finally {
      clearTimeout(timer);
      this.active = undefined;
    }
    if (this.stopped || (answer.expiresAt ?? Infinity) <= Date.now()) return;
    const text = answer.text.length > 3500 ? answer.text.slice(0, 3400) + "\n（回答过长已截断，可继续追问。）" : answer.text;
    // Persist only acknowledged replies. Unknown outcomes are never automatically re-sent.
    await this.reply(message, text);
    this.store.saveChatTurn(message.groupId, message.authorId, {
      role: "assistant", text, createdAt: Date.now(),
      expiresAt: answer.expiresAt ?? Math.min(message.occurredAt + RETENTION_MS, ...history.map(t => t.expiresAt ?? t.createdAt + RETENTION_MS)),
    });
    console.log("[QQ 对话] 已回复");
  }
}
