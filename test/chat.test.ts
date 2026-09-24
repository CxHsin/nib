import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatService } from "../src/chat.js";
import { ChatKnowledge, type ChatAgentOptions } from "../src/chat-agent.js";
import { Store } from "../src/store.js";
import { WebReader } from "../src/web-reader.js";
import { parseChatMessage } from "../src/message.js";
import type { AppConfig, CapturedMessage, ChatTurn } from "../src/types.js";

const config: AppConfig = {
  napcatWsUrl: "ws://127.0.0.1:1", groupIds: new Set(["100", "101"]), authorIds: new Set(["300"]),
  ownerId: "200", groupNames: {}, telegramBotToken: "test", telegramChatId: "test",
  deepseekApiKey: "test", modelId: "deepseek-v4-pro", dataDir: ".", maxAgentToolCalls: 5,
};
const message: CapturedMessage = {
  messageId: "1", groupId: "100", groupName: "测试群", authorId: "200", authorName: "主人",
  occurredAt: Date.now(), text: "我的项目叫 nib", urls: [],
};
const event = {
  post_type: "message", message_type: "group", self_id: 900, user_id: 200,
  group_id: 100, message_id: 1, time: Math.floor(Date.now() / 1000),
  message: [{ type: "at", data: { qq: "900" } }, { type: "text", data: { text: " 你好 https://example.com/a " } }],
};

test("仅主人在白名单群真实 @ 机器人触发；排除自身、全体、伪造文本和过旧事件", () => {
  const parse = (payload: unknown, owner: string | undefined = "200") => parseChatMessage(payload, config.groupIds, owner, {});
  assert.equal(parse(event)?.text, "你好 https://example.com/a");
  assert.deepEqual(parse(event)?.urls, ["https://example.com/a"]);
  assert.equal(parseChatMessage(event, config.groupIds, undefined, {}), undefined);
  for (const update of [
    { user_id: 300 }, { group_id: 999 }, { message_type: "private" }, { post_type: "message_sent" },
    { self_id: 200 }, { time: event.time - 301 }, { time: event.time + 100 },
    { message: [{ type: "at", data: { qq: "all" } }] },
    { message: [{ type: "at", data: { qq: "999" } }] },
    { message: [{ type: "text", data: { text: "[CQ:at,qq=900] @nib" } }] },
    { message: "[CQ:at,qq=900] 你好" },
  ]) assert.equal(parse({ ...event, ...update }), undefined);
});

test("对话串行处理、按群隔离、重启恢复，并对重复事件只回复一次", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nib-chat-"));
  const file = path.join(dir, "test.sqlite");
  let store = new Store(file);
  const histories: ChatTurn[][] = [];
  const replies: string[] = [];
  let active = 0;
  const runner = async (options: ChatAgentOptions) => {
    assert.equal(active++, 0);
    histories.push(options.history);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { text: `回答${options.message.messageId}` };
  };
  const makeChat = () => new ChatService(config, store, new WebReader(store), async (_message, text) => {
    replies.push(text); return "9";
  }, runner);
  let chat = makeChat();
  try {
    await Promise.all([
      chat.handle(message), chat.handle(message),
      chat.handle({ ...message, messageId: "2", text: "项目叫什么" }),
      chat.handle({ ...message, messageId: "3", groupId: "101" }),
      chat.handle({ ...message, messageId: "4", authorId: "300" }),
    ]);
    assert.deepEqual(replies, ["回答1", "回答2", "回答3"]);
    assert.equal(histories[0]!.length, 0);
    assert.deepEqual(histories[1]!.map((turn) => turn.text), ["我的项目叫 nib", "回答1"]);
    assert.equal(histories[2]!.length, 0);
    await chat.stop();
    store.close();
    store = new Store(file);
    chat = makeChat();
    await chat.handle(message);
    assert.equal(replies.length, 3);
    await chat.handle({ ...message, messageId: "5", text: "继续" });
    assert.equal(histories[3]!.length, 4);
    assert.equal(store.listChatTurns("100", "300").length, 0);
  } finally {
    await chat.stop(); store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("模型失败可以接续；发送结果未知不重发、不记为成功回答", async () => {
  const store = new Store(":memory:");
  const replies: string[] = [];
  let attempts = 0;
  const chat = new ChatService(config, store, new WebReader(store), async (_message, text) => {
    replies.push(text);
    if (text === "最终回答") throw new Error("未知发送状态");
    return "1";
  }, async () => {
    if (++attempts === 1) throw new Error("test failure");
    return { text: "最终回答" };
  });
  try {
    await chat.handle(message);
    await chat.handle({ ...message, messageId: "2" });
    await chat.handle({ ...message, messageId: "2" });
    assert.deepEqual(replies, ["这次处理未完成，请稍后再试。", "最终回答"]);
    assert.equal(attempts, 2);
    assert.equal(store.listChatTurns("100", "200").some((turn) => turn.role === "assistant"), false);
  } finally { await chat.stop(); store.close(); }
});

test("退出中止当前 agent 并丢弃排队请求，不再发送", async () => {
  const store = new Store(":memory:");
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let called = 0;
  const chat = new ChatService(config, store, new WebReader(store), async () => {
    assert.fail("退出时不应发送");
  }, async ({ signal }) => {
    called++;
    markStarted();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return { text: "不应到达" };
  });
  const request = chat.handle(message);
  const queued = chat.handle({ ...message, messageId: "2" });
  await started;
  await chat.stop();
  await Promise.all([request, queued]);
  assert.equal(called, 1);
  store.close();
});

test("工具查询不能跨群；只可读取用户直接链接和本次查询结果，不跟随网页链接", async () => {
  const store = new Store(":memory:");
  try {
    store.saveMessage({ ...message, messageId: "10", authorId: "300", text: "agent 产品", urls: ["https://example.com/group"] });
    store.saveMessage({ ...message, messageId: "11", groupId: "101", urls: ["https://example.com/other"] });
    const calls: string[] = [];
    const knowledge = new ChatKnowledge({
      store, message: { ...message, urls: ["https://example.com/direct"] },
      history: [{ role: "user", text: "https://example.com/history", createdAt: 1 }],
      webReader: { read: async (url) => {
        calls.push(url);
        return { url, fetchedAt: Date.now(), ok: true, title: "页面", content: "https://example.com/nested", error: null };
      } },
    });
    await assert.rejects(knowledge.read("https://example.com/group"));
    const found = knowledge.query("agent");
    assert.match(JSON.stringify(found), /agent 产品/);
    assert.doesNotMatch(JSON.stringify(found), /other/);
    await knowledge.read("https://example.com/group");
    await knowledge.read("https://example.com/direct");
    await knowledge.read("https://example.com/history");
    await assert.rejects(knowledge.read("https://example.com/other"));
    await assert.rejects(knowledge.read("https://example.com/nested"));
    assert.equal(calls.length, 3);
  } finally { store.close(); }
});

test("一周遗忘：过期对话不进入模型且被清理", () => {
  const store = new Store(":memory:");
  try {
    for (let i = 0; i < 20; i++) store.saveChatTurn("100", "200", { role: "user", text: String(i), createdAt: 1 });
    store.cleanup(Date.now());
    assert.equal(store.listChatTurns("100", "200").length, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS n FROM chat_turns").get() as { n: number }).n, 0);
  } finally { store.close(); }
});
