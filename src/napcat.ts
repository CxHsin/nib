import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { AppConfig, CapturedMessage } from "./types.js";
import { parseCapturedMessage, parseChatMessage } from "./message.js";

export interface NapCatCallbacks {
  onMessage(message: CapturedMessage): void | Promise<void>;
  onChatMessage?(message: CapturedMessage): void | Promise<void>;
  onConnected?(): void;
  onDisconnected?(reason: string): void;
}

export class NapCatClient {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 1_000;
  private selfId: string | undefined;
  private pending = new Map<string, {
    resolve(value: string): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  constructor(private readonly config: AppConfig, private readonly callbacks: NapCatCallbacks) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "nib shutdown");
    this.rejectPending();
  }

  async reply(message: CapturedMessage, text: string): Promise<string> {
    if (!this.config.ownerId || message.authorId !== this.config.ownerId ||
        !this.config.groupIds.has(message.groupId)) throw new Error("QQ 回复目标未授权");
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.stopped) throw new Error("NapCat 未连接");
    const forward = Array.from(text).length > 100;
    if (forward && !this.selfId) throw new Error("尚未识别机器人 QQ 号，无法合并转发");
    const echo = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error("QQ 发送确认超时，结果未知，不自动重发"));
      }, 15_000);
      this.pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({
        action: forward ? "send_group_forward_msg" : "send_group_msg",
        params: forward ? {
          group_id: message.groupId,
          messages: [{ type: "node", data: {
            name: "nib", uin: this.selfId,
            content: [{ type: "text", data: { text } }],
          } }],
          source: "nib",
          summary: "nib 的回答",
        } : {
          group_id: message.groupId,
          message: [
            { type: "reply", data: { id: message.messageId } },
            { type: "text", data: { text } },
          ],
        },
        echo,
      }), (error) => {
        if (!error) return;
        const pending = this.pending.get(echo);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(echo);
        pending.reject(new Error("QQ 消息发送失败"));
      });
    });
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("NapCat 连接关闭，发送结果未知，不自动重发"));
    }
    this.pending.clear();
  }

  private handleResponse(payload: unknown): boolean {
    if (!payload || typeof payload !== "object" || !("echo" in payload)) return false;
    const response = payload as { echo?: unknown; status?: unknown; retcode?: unknown; data?: { message_id?: unknown } };
    if (typeof response.echo !== "string") return true;
    const pending = this.pending.get(response.echo);
    if (!pending) return true;
    clearTimeout(pending.timer);
    this.pending.delete(response.echo);
    const id = response.data?.message_id;
    if (response.status === "ok" && response.retcode === 0 && (typeof id === "number" || typeof id === "string")) {
      pending.resolve(String(id));
    } else pending.reject(new Error(`QQ 发送未成功确认，retcode=${String(response.retcode)}`));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const headers = this.config.napcatAccessToken
      ? { Authorization: `Bearer ${this.config.napcatAccessToken}` }
      : undefined;
    const socket = new WebSocket(this.config.napcatWsUrl, { headers });
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectDelay = 1_000;
      console.log("[NapCat] WebSocket 已连接");
      this.callbacks.onConnected?.();
    });

    socket.on("message", (data) => {
      if (this.stopped) return;
      try {
        const payload: unknown = JSON.parse(data.toString());
        if (this.handleResponse(payload)) return;
        if (payload && typeof payload === "object" && "self_id" in payload &&
            /^\d+$/.test(String(payload.self_id))) this.selfId = String(payload.self_id);
        const chat = parseChatMessage(payload, this.config.groupIds, this.config.ownerId, this.config.groupNames);
        if (chat && this.callbacks.onChatMessage) {
          void Promise.resolve(this.callbacks.onChatMessage(chat)).catch(() => {
            console.error("[QQ 对话] 处理失败");
          });
        }
        // Never collect the bot's own replies, even if it appears in the digest whitelist.
        if (payload && typeof payload === "object" && "self_id" in payload && "user_id" in payload &&
            String(payload.self_id) === String(payload.user_id)) return;
        const message = parseCapturedMessage(
          payload,
          this.config.groupIds,
          undefined,
          this.config.groupNames,
        );
        if (message) void Promise.resolve(this.callbacks.onMessage(message)).catch((error: unknown) => {
          console.error("[NapCat] 保存消息失败", error);
        });
      } catch (error) {
        console.warn("[NapCat] 忽略无法解析的事件", error);
      }
    });

    socket.on("error", (error) => console.error("[NapCat] WebSocket 错误", error.message));
    socket.on("close", (code, reason) => {
      this.rejectPending();
      const detail = `${code} ${reason.toString()}`.trim();
      console.warn(`[NapCat] WebSocket 已断开：${detail}`);
      this.callbacks.onDisconnected?.(detail);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
