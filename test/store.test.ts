import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";
import { Store } from "../src/store.js";

test("消息幂等保存、时间窗查询和投递状态持久化", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nib-test-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  try {
    const message = {
      messageId: "1", groupId: "10", groupName: "群", authorId: "20", authorName: "人",
      occurredAt: 2000, text: "正文", urls: ["https://example.com"],
    };
    assert.equal(store.saveMessage(message, 3000), true);
    assert.equal(store.saveMessage(message, 3000), false);
    assert.deepEqual(store.listMessages(1000, 3000), [message]);
    assert.deepEqual(store.listMessages(2001, 3000), []);

    const digest = store.saveDigest({ start: 1000, end: 3000, hasCollectionGap: false }, "晚报", 3001);
    store.prepareDelivery(digest.id, ["第一段", "第二段"]);
    const pending = store.listUnsentSegments();
    assert.equal(pending.length, 2);
    store.markSegmentSending(pending[0]!.id);
    store.markSegmentSent(pending[0]!.id, "99");
    assert.equal(store.listUnsentSegments().length, 1);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
