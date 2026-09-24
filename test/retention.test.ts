import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/store.js";
import { RETENTION_MS } from "../src/time.js";
import { parseCapturedMessage, parseChatMessage } from "../src/message.js";

test("全员采集不放宽主人触发和群边界", () => {
  const event = { post_type: "message", message_type: "group", user_id: 999, self_id: 900,
    group_id: 100, message_id: 1, time: Date.now()/1000, raw_message: "普通成员",
    message: [{type:"at",data:{qq:"900"}}] };
  assert.ok(parseCapturedMessage(event,new Set(["100"]),undefined,{}));
  assert.equal(parseCapturedMessage({...event,group_id:101},new Set(["100"]),undefined,{}),undefined);
  assert.equal(parseChatMessage(event,new Set(["100"]),"200",{}),undefined);
});

test("七天边界清理消息、缓存、对话、去重、晚报和投递正文；清理前查询也排除过期", () => {
  const store = new Store(":memory:");
  const now = Date.now(); const cutoff = now - RETENTION_MS;
  try {
    for (const [id,time] of [["old",cutoff],["new",cutoff+1]] as const) {
      const m = {messageId:id,groupId:"100",groupName:"群",authorId:"999",authorName:"人",occurredAt:time,text:id,urls:[]};
      store.saveMessage(m,now); store.claimChatRequest(m);
      store.saveChatTurn("100","200",{role:"user",text:id,createdAt:time});
      store.saveLink({url:id,fetchedAt:time,ok:true,title:null,content:id,error:null});
      const d=store.saveDigest({start:time,end:time+100,hasCollectionGap:false},id,now);
      store.prepareDelivery(d.id,[id]);
    }
    assert.deepEqual(store.listGroupMessages("100","",now).map(m=>m.text),["new"]);
    assert.deepEqual(store.listChatTurns("100","200",now).map(m=>m.text),["new"]);
    store.cleanup(cutoff);
    for(const table of ["messages","link_cache","chat_turns","chat_requests","digests","delivery_segments"]) {
      assert.equal((store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,1,table);
    }
  } finally {store.close();}
});
