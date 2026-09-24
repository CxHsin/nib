import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentResult } from "../src/agent.js";

const messages = [{
  messageId: "1", groupId: "10", groupName: "群", authorId: "20", authorName: "人",
  occurredAt: 2000, text: "Agent 产品发布 https://example.com", urls: ["https://example.com"],
}];

test("agent 结果只能引用候选消息与直接链接", () => {
  assert.deepEqual(validateAgentResult({
    items: [{
      summary: "发布新的 Agent 产品", quoteMessageId: "1",
      sourceMessageIds: ["1"], links: ["https://example.com"],
    }],
    unreadableLinks: [],
  }, messages), {
    items: [{
      summary: "发布新的 Agent 产品", quoteMessageId: "1",
      sourceMessageIds: ["1"], links: ["https://example.com"],
    }],
    unreadableLinks: [],
  });
  assert.throws(() => validateAgentResult({
    items: [{ summary: "伪造", quoteMessageId: "2", sourceMessageIds: ["2"], links: [] }],
    unreadableLinks: [],
  }, messages), /不属于候选消息/);
});
