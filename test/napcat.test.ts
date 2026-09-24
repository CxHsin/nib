import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { NapCatClient } from "../src/napcat.js";
import type { AppConfig, CapturedMessage } from "../src/types.js";

test("NapCat 分流 @、匹配乱序回执、拒绝越权目标，并处理失败及断线", { timeout: 10_000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config: AppConfig = {
    napcatWsUrl: `ws://127.0.0.1:${address.port}`, groupIds: new Set(["100"]), authorIds: new Set(["200", "300", "900"]),
    ownerId: "200", groupNames: {}, telegramBotToken: "test", telegramChatId: "test", deepseekApiKey: "test",
    modelId: "deepseek-v4-pro", dataDir: ".", maxAgentToolCalls: 5,
  };
  const captured: CapturedMessage[] = [];
  const chats: CapturedMessage[] = [];
  let received!: () => void;
  const incoming = new Promise<void>((resolve) => { received = resolve; });
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const client = new NapCatClient(config, {
    onConnected: opened,
    onMessage: (message) => { captured.push(message); if (captured.length === 2 && chats.length === 1) received(); },
    onChatMessage: (message) => { chats.push(message); if (captured.length === 2 && chats.length === 1) received(); },
  });
  const connection = once(server, "connection");
  client.start();
  const [socket] = await connection;
  await ready;
  try {
    const base = { post_type: "message", message_type: "group", self_id: 900, group_id: 100, time: Math.floor(Date.now() / 1000) };
    socket.send(JSON.stringify({ ...base, message_id: 1, user_id: 200,
      message: [{ type: "at", data: { qq: "900" } }, { type: "text", data: { text: "你好" } }] }));
    socket.send(JSON.stringify({ ...base, message_id: 2, user_id: 900, raw_message: "自身不收录" }));
    socket.send(JSON.stringify({ ...base, message_id: 3, user_id: 300, raw_message: "晚报候选" }));
    await incoming;
    assert.equal(chats.length, 1);
    assert.deepEqual(captured.map((message) => message.messageId), ["1", "3"]);
    const request = chats[0]!;
    await assert.rejects(client.reply({ ...request, groupId: "999" }, "越权"), /未授权/);
    await assert.rejects(client.reply({ ...request, authorId: "300" }, "越权"), /未授权/);
    const requests: Array<{ echo: string; action: string; params: { group_id: string; message: unknown[]; messages?: unknown[] } }> = [];
    socket.on("message", (data: { toString(): string }) => {
      const payload = JSON.parse(data.toString()) as typeof requests[number];
      requests.push(payload);
      if (requests.length === 2) {
        socket.send(JSON.stringify({ echo: requests[1]!.echo, status: "ok", retcode: 0, data: { message_id: 22 } }));
        socket.send(JSON.stringify({ echo: requests[0]!.echo, status: "ok", retcode: 0, data: { message_id: 11 } }));
      } else if (requests.length === 3 || requests.length === 4) {
        socket.send(JSON.stringify({ echo: payload.echo, status: "ok", retcode: 0, data: { message_id: 33 } }));
      } else if (requests.length === 5) {
        socket.send(JSON.stringify({ echo: payload.echo, status: "failed", retcode: 1200 }));
      } else if (requests.length === 6) socket.close();
    });
    assert.deepEqual(await Promise.all([client.reply(request, "[CQ:at,qq=all]"), client.reply(request, "第二条")]), ["11", "22"]);
    assert.equal(requests[0]!.action, "send_group_msg");
    assert.equal(requests[0]!.params.group_id, "100");
    assert.deepEqual(requests[0]!.params.message, [
      { type: "reply", data: { id: "1" } }, { type: "text", data: { text: "[CQ:at,qq=all]" } },
    ]);
    await client.reply(request, "你".repeat(100));
    assert.equal(requests[2]!.action, "send_group_msg");
    await client.reply(request, "😀".repeat(101));
    assert.equal(requests[3]!.action, "send_group_forward_msg");
    assert.deepEqual(requests[3]!.params.messages, [{ type: "node", data: { name: "nib", uin: "900", content: [{ type: "text", data: { text: "😀".repeat(101) } }] } }]);
    await assert.rejects(client.reply(request, "失败"), /retcode=1200/);
    await assert.rejects(client.reply(request, "断线"), /结果未知/);
    assert.equal(requests.length, 6);
  } finally {
    client.stop();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
