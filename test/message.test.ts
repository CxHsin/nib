import assert from "node:assert/strict";
import test from "node:test";
import { extractUrls, parseCapturedMessage } from "../src/message.js";

const groups = new Set(["100"]);
const authors = new Set(["200"]);

test("只接收白名单群与发言人的群消息", () => {
  const message = parseCapturedMessage({
    post_type: "message",
    message_type: "group",
    message_id: 1,
    group_id: 100,
    user_id: 200,
    time: 1_700_000_000,
    raw_message: "Agent 新产品 https://example.com/a",
    sender: { card: "小明" },
  }, groups, authors, { "100": "Agent 群" });
  assert.deepEqual(message, {
    messageId: "1",
    groupId: "100",
    groupName: "Agent 群",
    authorId: "200",
    authorName: "小明",
    occurredAt: 1_700_000_000_000,
    text: "Agent 新产品 https://example.com/a",
    urls: ["https://example.com/a"],
  });
  assert.equal(parseCapturedMessage({
    post_type: "message", message_type: "group", message_id: 2,
    group_id: 999, user_id: 200, raw_message: "不应保存",
  }, groups, authors, {}), undefined);
});

test("从嵌套 OneBot 消息段提取并去重链接", () => {
  assert.deepEqual(extractUrls([
    { type: "text", data: { text: "看 https://example.com/a。" } },
    { type: "json", data: { url: "https://example.com/a", jumpUrl: "https://example.com/b" } },
  ]), ["https://example.com/a", "https://example.com/b"]);
});
