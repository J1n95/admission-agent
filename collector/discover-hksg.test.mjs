import assert from "node:assert/strict";
import { discoveryTerms, searchHksg } from "./discover-hksg.mjs";

assert.deepEqual(discoveryTerms({ nameZh: "大数据科技理学硕士", aliases: ["大数据科技硕士", "Big Data Technology"] }), ["大数据科技"]);
let requested;
const rows = await searchHksg("电子工程", async url => {
  requested = url;
  return { ok: true, json: async () => ({ data: [{ id: 1 }] }) };
});
assert.deepEqual(rows, [{ id: 1 }]);
assert.equal(requested.searchParams.get("limit"), "100");
assert.equal(requested.searchParams.get("keywords"), "电子工程");
console.log("HKSg discovery checks passed");
