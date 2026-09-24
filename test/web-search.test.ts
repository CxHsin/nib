import test from "node:test";
import assert from "node:assert/strict";
import { TinyFish } from "@tiny-fish/sdk";
import { webSearch } from "../src/web-search.js";

test("搜索通过SDK限定参数，限制结果长度，错误不泄露凭据", async (t) => {
  t.mock.method(TinyFish.prototype, "get", async (url: string, options: {params:{query:string}}) => {
    assert.equal(url,"https://api.search.tinyfish.ai/");
    assert.equal(options.params.query,"公开关键词");
    return {query:"公开关键词",page:0,total_results:8,results:Array.from({length:8},(_,i)=>({
      position:i+1,site_name:"example.com",title:"标题",url:`https://example.com/${i}`,snippet:"字".repeat(2000),
    }))};
  });
  const result=await webSearch("公开关键词","secret",new AbortController().signal);
  assert.equal(result.length,5);assert.equal(result[0]?.snippet.length,1200);
  await assert.rejects(webSearch(" ","secret",new AbortController().signal));
  t.mock.restoreAll();
  t.mock.method(TinyFish.prototype,"get",async()=>{throw new Error("secret");});
  await assert.rejects(webSearch("公开关键词","secret",new AbortController().signal),e=>e instanceof Error && !e.message.includes("secret"));
});
