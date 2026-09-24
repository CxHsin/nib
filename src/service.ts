import path from "node:path";
import type { AppConfig, DigestWindow } from "./types.js";
import { Store } from "./store.js";
import { WebReader } from "./web-reader.js";
import { NapCatClient } from "./napcat.js";
import { TelegramSender } from "./telegram.js";
import { runDigestAgent } from "./agent.js";
import { ChatService } from "./chat.js";
import { formatDigest, splitTelegramMessage } from "./digest-format.js";
import { latestDigestCut, nextDigestCut, ONE_DAY_MS, RETENTION_MS } from "./time.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
const OFFLINE_GAP_THRESHOLD_MS = 3 * HEARTBEAT_INTERVAL_MS;

export class NibService {
  readonly store: Store;
  private readonly reader: WebReader;
  private readonly telegram: TelegramSender;
  private readonly napcat: NapCatClient;
  private readonly chat: ChatService;
  private digestTimer: NodeJS.Timeout | undefined;
  private digestRetryTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private deliveryRetryTimer: NodeJS.Timeout | undefined;
  private napcatGapStartedAt: number | undefined;
  private runningDigest = false;

  constructor(private readonly config: AppConfig) {
    this.store = new Store(path.join(config.dataDir, "nib.sqlite"));
    this.reader = new WebReader(this.store);
    this.telegram = new TelegramSender(config.telegramBotToken, config.telegramChatId, this.store);
    this.napcat = new NapCatClient(config, {
      onChatMessage: (message) => this.chat.handle(message),
      onMessage: (message) => {
        if (this.store.saveMessage(message)) {
          console.log("[消息] 已保存群消息");
        }
      },
      onConnected: () => {
        if (this.napcatGapStartedAt && Date.now() - this.napcatGapStartedAt > OFFLINE_GAP_THRESHOLD_MS) {
          this.store.recordGap(this.napcatGapStartedAt, Date.now());
        }
        this.napcatGapStartedAt = undefined;
      },
      onDisconnected: () => {
        this.napcatGapStartedAt ??= Date.now();
      },
    });
    this.chat = new ChatService(config, this.store, this.reader, (message, text) => this.napcat.reply(message, text));
  }

  async start(now = Date.now()): Promise<void> {
    console.log(this.config.ownerId ? "[QQ 对话] 已启用，仅指定主人可 @ 触发" : "[QQ 对话] 未启用：请在 .env 配置 QQ_OWNER_ID");
    this.store.cleanup(now - RETENTION_MS);
    const runtime = this.store.initializeRuntime(now);
    if (!runtime.firstStart && runtime.previousHeartbeat && now - runtime.previousHeartbeat > OFFLINE_GAP_THRESHOLD_MS) {
      this.store.recordGap(runtime.previousHeartbeat, now);
    }
    this.heartbeatTimer = setInterval(() => {
      this.store.heartbeat(Date.now());
      this.store.cleanup(Date.now() - RETENTION_MS);
    }, HEARTBEAT_INTERVAL_MS);
    this.napcatGapStartedAt = now;
    this.napcat.start();

    try {
      await this.telegram.deliverPending();
    } catch (error) {
      console.error("[Telegram] 待发送内容恢复失败，稍后重试", error);
      this.scheduleDeliveryRetry();
    }
    await this.catchUpLatest(now);
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    if (this.digestTimer) clearTimeout(this.digestTimer);
    if (this.digestRetryTimer) clearTimeout(this.digestRetryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.deliveryRetryTimer) clearTimeout(this.deliveryRetryTimer);
    this.napcat.stop();
    await this.chat.stop();
    this.store.heartbeat(Date.now());
    this.store.close();
  }

  async runWindow(windowEnd: number): Promise<void> {
    if (this.runningDigest) return;
    this.store.cleanup(Date.now() - RETENTION_MS);
    if (windowEnd - ONE_DAY_MS <= Date.now() - RETENTION_MS) return;
    this.runningDigest = true;
    try {
      let digest = this.store.getDigestByEnd(windowEnd);
      if (!digest) {
        const serviceStartedAt = Number(this.store.getMeta("service_started_at") ?? windowEnd - ONE_DAY_MS);
        const window: DigestWindow = {
          start: Math.max(windowEnd - ONE_DAY_MS, serviceStartedAt),
          end: windowEnd,
          hasCollectionGap: this.store.hasGap(windowEnd - ONE_DAY_MS, windowEnd),
        };
        const result = await runDigestAgent({
          store: this.store,
          webReader: this.reader,
          window,
          apiKey: this.config.deepseekApiKey,
          modelId: this.config.modelId,
          maxToolCalls: this.config.maxAgentToolCalls,
        });
        const body = formatDigest(result, this.store.listMessages(window.start, window.end), window);
        digest = this.store.saveDigest(window, body);
        console.log(`[晚报] 已生成 ${windowEnd}`);
      }
      this.store.prepareDelivery(digest.id, splitTelegramMessage(digest.body));
      await this.telegram.deliverPending();
      this.store.cleanup(Date.now() - RETENTION_MS);
    } finally {
      this.runningDigest = false;
    }
  }

  private scheduleDeliveryRetry(): void {
    if (this.deliveryRetryTimer) return;
    this.deliveryRetryTimer = setTimeout(() => {
      this.deliveryRetryTimer = undefined;
      void this.telegram.deliverPending().catch((error: unknown) => {
        console.error("[Telegram] 自动重试仍失败", error);
        this.scheduleDeliveryRetry();
      });
    }, 5 * 60_000);
  }

  private scheduleDigestRetry(windowEnd: number): void {
    if (this.digestRetryTimer) return;
    this.digestRetryTimer = setTimeout(() => {
      this.digestRetryTimer = undefined;
      void this.runWindow(windowEnd).catch((error: unknown) => {
        console.error("[晚报] 自动重试仍失败", error);
        this.scheduleDigestRetry(windowEnd);
      });
    }, 5 * 60_000);
  }

  private async catchUpLatest(now: number): Promise<void> {
    const latestCut = latestDigestCut(now);
    const startedAt = Number(this.store.getMeta("service_started_at") ?? now);
    if (startedAt > latestCut) return;
    try {
      await this.runWindow(latestCut);
    } catch (error) {
      console.error("[晚报] 启动补发失败，将在下次调度重试", error);
    }
  }

  private scheduleNext(): void {
    const now = Date.now();
    const next = nextDigestCut(now);
    this.digestTimer = setTimeout(() => {
      void this.runWindow(next)
        .catch((error: unknown) => {
          console.error("[晚报] 生成或发送失败", error);
          this.scheduleDigestRetry(next);
          if (this.store.listUnsentSegments().length > 0) this.scheduleDeliveryRetry();
        })
        .finally(() => this.scheduleNext());
    }, Math.max(0, next - now));
    console.log(`[调度] 下次晚报：${new Date(next).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
  }
}
