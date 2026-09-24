import type { AgentDigestResult, CapturedMessage, DigestWindow } from "./types.js";
import { dateLabelShanghai, formatShanghai } from "./time.js";

export function formatDigest(
  result: AgentDigestResult,
  messages: CapturedMessage[],
  window: DigestWindow,
): string {
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  const lines = [
    `nib 群聊晚报｜${dateLabelShanghai(window.end)}`,
    `范围：${formatShanghai(window.start)} — ${formatShanghai(window.end)}`,
  ];
  if (window.hasCollectionGap) lines.push("⚠️ 本期存在程序离线造成的记录缺口。");

  if (result.items.length === 0) {
    lines.push("", "本期无符合条件的内容。");
  } else {
    result.items.forEach((item, index) => {
      const quote = byId.get(item.quoteMessageId);
      if (!quote) return;
      const sources = item.sourceMessageIds.map((id) => byId.get(id)).filter(Boolean) as CapturedMessage[];
      const sourceNames = [...new Set(sources.map((source) => `${source.authorName}（${source.authorId}）`))];
      const groupNames = [...new Set(sources.map((source) => source.groupName))];
      const times = sources.map((source) => source.occurredAt);
      lines.push(
        "",
        `${index + 1}. ${item.summary}`,
        `关键原话：${quote.text}`,
      );
      if (item.links.length > 0) lines.push(`链接：${item.links.join("\n")}`);
      lines.push(
        `发言人：${sourceNames.join("、")}`,
        `群：${groupNames.join("、")}`,
        `时间：${formatShanghai(Math.min(...times))}`,
      );
    });
  }

  if (result.unreadableLinks.length > 0) {
    lines.push("", "待读取链接：");
    for (const entry of result.unreadableLinks) lines.push(`- ${entry.url}`);
  }
  return lines.join("\n");
}

export function splitTelegramMessage(body: string, maxLength = 3900): string[] {
  if (body.length <= maxLength) return [body];
  const parts: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    if (line.length > maxLength) {
      if (current) parts.push(current);
      for (let start = 0; start < line.length; start += maxLength) {
        parts.push(line.slice(start, start + maxLength));
      }
      current = "";
    } else if (!current) {
      current = line;
    } else if (current.length + line.length + 1 <= maxLength) {
      current += `\n${line}`;
    } else {
      parts.push(current);
      current = line;
    }
  }
  if (current) parts.push(current);
  return parts;
}
