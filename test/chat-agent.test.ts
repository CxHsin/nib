import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { runChatAgent, type ChatAgentOptions } from "../src/chat-agent.js";
import { Store } from "../src/store.js";

function response(content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage {
  return {
    role: "assistant", content, stopReason, api: "openai-completions", provider: "deepseek", model: "deepseek-v4-pro",
    timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function options(store: Store): ChatAgentOptions {
  return {
    store, webReader: { read: async (url) => ({ url, fetchedAt: Date.now(), ok: true, title: "例子", content: "工具读取的正文", error: null }) },
    message: { messageId: "1", groupId: "100", groupName: "测试", authorId: "200", authorName: "测试",
      occurredAt: Date.now(), text: "查询消息并阅读链接", urls: [] },
    history: [], apiKey: "offline-test", modelId: "deepseek-v4-pro", maxToolCalls: 5,
    signal: AbortSignal.timeout(10_000),
  };
}

test("真实 pi SDK 循环：查询→读网页→最终回答，仅开放两个受限工具", { timeout: 15_000 }, async (t) => {
  const store = new Store(":memory:");
  const args = options(store);
  store.saveMessage({ ...args.message, messageId: "10", text: "分享", urls: ["https://example.com"] });
  let requests = 0;
  t.mock.method(ModelRuntime.prototype, "streamSimple", (...params: Parameters<ModelRuntime["streamSimple"]>) => {
    const [, context] = params;
    requests++;
    const tools = context.tools ?? context.messages.flatMap((message) => message.role === "system" ? message.toolsAdded ?? [] : []);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["query_group_messages", "read_link"]);
    const stream = createAssistantMessageEventStream();
    const result = requests === 1
      ? response([{ type: "toolCall", id: "q1", name: "query_group_messages", arguments: { keyword: "" } }], "toolUse")
      : requests === 2
        ? response([{ type: "toolCall", id: "q2", name: "read_link", arguments: { url: "https://example.com" } }], "toolUse")
        : response([{ type: "text", text: "我已根据工具正文回答。" }], "stop");
    if (requests === 2) assert.match(JSON.stringify(context.messages), /https:\/\/example.com/);
    if (requests === 3) assert.match(JSON.stringify(context.messages), /工具读取的正文/);
    stream.push({ type: "done", reason: result.stopReason as "stop" | "toolUse", message: result });
    return stream;
  });
  try {
    assert.equal((await runChatAgent(args)).text, "我已根据工具正文回答。");
    assert.equal(requests, 3);
  } finally { store.close(); }
});

test("真实 pi SDK 在工具预算耗尽后停止，不允许模型无限请求", { timeout: 15_000 }, async (t) => {
  const store = new Store(":memory:");
  let requests = 0;
  t.mock.method(ModelRuntime.prototype, "streamSimple", (...params: Parameters<ModelRuntime["streamSimple"]>) => {
    const stream = createAssistantMessageEventStream();
    if (params[2]?.signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: { ...response([], "stop"), stopReason: "aborted", errorMessage: "aborted" } });
      return stream;
    }
    if (requests >= 10) throw new Error("test safety stop");
    const result = response([{ type: "toolCall", id: `q${++requests}`, name: "query_group_messages", arguments: { keyword: "" } }], "toolUse");
    stream.push({ type: "done", reason: "toolUse", message: result });
    return stream;
  });
  try {
    await assert.rejects(runChatAgent({ ...options(store), maxToolCalls: 1 }), /调用上限/);
    assert.ok(requests <= 2);
  } finally { store.close(); }
});
