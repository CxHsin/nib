import assert from "node:assert/strict";
import test from "node:test";
import { latestDigestCut, nextDigestCut, previousDigestCut } from "../src/time.js";

test("北京时间 20:00 是晚报边界", () => {
  const before = Date.parse("2026-09-24T11:59:59Z");
  const at = Date.parse("2026-09-24T12:00:00Z");
  assert.equal(latestDigestCut(before), Date.parse("2026-09-23T12:00:00Z"));
  assert.equal(latestDigestCut(at), at);
  assert.equal(nextDigestCut(before), at);
  assert.equal(nextDigestCut(at), Date.parse("2026-09-25T12:00:00Z"));
  assert.equal(previousDigestCut(at), Date.parse("2026-09-23T12:00:00Z"));
});
