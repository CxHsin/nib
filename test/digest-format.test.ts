import assert from "node:assert/strict";
import test from "node:test";
import { formatDigest, splitTelegramMessage } from "../src/digest-format.js";

const message = {
  messageId: "1", groupId: "10", groupName: "Agent 群", authorId: "20", authorName: "小明",
  occurredAt: Date.parse("2026-09-24T08:00:00Z"), text: "关键原话", urls: ["https://example.com"],
};

test("晚报包含确认的字段，并在没有链接时省略链接行", () => {
  const window = {
    start: Date.parse("2026-09-23T12:00:00Z"),
    end: Date.parse("2026-09-24T12:00:00Z"),
    hasCollectionGap: false,
  };
  const withLink = formatDigest({
    items: [{ summary: "主题摘要", quoteMessageId: "1", sourceMessageIds: ["1"], links: ["https://example.com"] }],
    unreadableLinks: [],
  }, [message], window);
  assert.match(withLink, /主题摘要/);
  assert.match(withLink, /关键原话：关键原话/);
  assert.match(withLink, /链接：https:\/\/example\.com/);
  assert.match(withLink, /发言人：小明（20）/);
  assert.match(withLink, /群：Agent 群/);
  assert.match(withLink, /时间：/);

  const withoutLink = formatDigest({
    items: [{ summary: "主题摘要", quoteMessageId: "1", sourceMessageIds: ["1"], links: [] }],
    unreadableLinks: [],
  }, [message], window);
  assert.doesNotMatch(withoutLink, /链接：/);
});

test("Telegram 分段自身不重复添加分段编号", () => {
  const parts = splitTelegramMessage("a\n" + "b".repeat(20), 10);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => !/^\[\d+\/\d+\]/u.test(part)));
});
