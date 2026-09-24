import type { CapturedMessage } from "./types.js";

interface OneBotMessageEvent {
  post_type?: unknown;
  message_type?: unknown;
  message_id?: unknown;
  group_id?: unknown;
  user_id?: unknown;
  time?: unknown;
  raw_message?: unknown;
  message?: unknown;
  sender?: { card?: unknown; nickname?: unknown };
  self_id?: unknown;
}

/** Only structured at segments count; plain text and quoted CQ strings do not. */
export function parseChatMessage(
  input: unknown,
  allowedGroups: Set<string>,
  ownerId: string | undefined,
  groupNames: Record<string, string>,
  now = Date.now(),
): CapturedMessage | undefined {
  if (!ownerId || !input || typeof input !== "object") return undefined;
  const event = input as OneBotMessageEvent;
  const selfId = asId(event.self_id);
  if (!selfId || asId(event.user_id) !== ownerId || ownerId === selfId) return undefined;
  if (!Array.isArray(event.message)) return undefined;
  const segments = event.message as Array<{ type?: unknown; data?: { qq?: unknown; text?: unknown } } | null>;
  if (!segments.some((part) => part?.type === "at" && asId(part.data?.qq) === selfId)) return undefined;
  if (typeof event.time !== "number" || !Number.isFinite(event.time)) return undefined;
  if (event.time * 1000 < now - 5 * 60_000 || event.time * 1000 > now + 60_000) return undefined;
  const text = segments.filter((part) => part?.type === "text" && typeof part.data?.text === "string")
    .map((part) => part!.data!.text as string).join("").trim();
  return parseCapturedMessage({ ...event, raw_message: text || "你好", message: [] },
    allowedGroups, new Set([ownerId]), groupNames);
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function asMessageId(value: unknown): string | undefined {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function collectStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 5) return;
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const child of value) collectStrings(child, output, depth + 1);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectStrings(child, output, depth + 1);
  }
}

export function extractUrls(value: unknown): string[] {
  const strings: string[] = [];
  collectStrings(value, strings);
  const urls = strings.flatMap((text) => text.match(/https?:\/\/[^\s<>"'\]\[（）()，。]+/giu) ?? []);
  return [...new Set(urls.map((url) => url.replace(/[.,;:!?，。！？；：]+$/u, "")))];
}

function displayText(event: OneBotMessageEvent): string {
  if (typeof event.raw_message === "string" && event.raw_message.trim()) {
    return event.raw_message.trim();
  }
  const strings: string[] = [];
  collectStrings(event.message, strings);
  return strings.join(" ").trim();
}

export function parseCapturedMessage(
  input: unknown,
  allowedGroups: Set<string>,
  allowedAuthors: Set<string> | undefined,
  groupNames: Record<string, string>,
): CapturedMessage | undefined {
  if (!input || typeof input !== "object") return undefined;
  const event = input as OneBotMessageEvent;
  if (event.post_type !== "message" || event.message_type !== "group") return undefined;

  const groupId = asId(event.group_id);
  const authorId = asId(event.user_id);
  const messageId = asMessageId(event.message_id);
  if (!groupId || !authorId || !messageId) return undefined;
  if (!allowedGroups.has(groupId) || (allowedAuthors && !allowedAuthors.has(authorId))) return undefined;

  const text = displayText(event);
  const urls = extractUrls([event.raw_message, event.message]);
  if (!text && urls.length === 0) return undefined;
  const seconds = typeof event.time === "number" && Number.isFinite(event.time)
    ? event.time
    : Math.floor(Date.now() / 1000);
  const card = typeof event.sender?.card === "string" ? event.sender.card.trim() : "";
  const nickname = typeof event.sender?.nickname === "string" ? event.sender.nickname.trim() : "";

  return {
    messageId,
    groupId,
    groupName: groupNames[groupId] || `QQ群 ${groupId}`,
    authorId,
    authorName: card || nickname || authorId,
    occurredAt: seconds * 1000,
    text,
    urls,
  };
}
