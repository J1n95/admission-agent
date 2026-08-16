import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./discover-programmes.mjs", import.meta.url), "utf8");
assert.match(source, /SavedQueryService/, "HKU discovery must use the official catalogue API");
assert.match(source, /programme-filter/, "CUHK discovery must use the official programme filter");
assert.match(source, /print_result\.php/, "HKUST discovery must use the official catalogue endpoint");
assert.match(source, /find-your-programmes-tpg/, "PolyU discovery must use the official catalogue page");
assert.match(source, /cityu\.edu\.hk\/pg\/taught-postgraduate-programmes\/list/, "CityU discovery must use the official programme list");
assert.match(source, /graduate degree programmes as of AY2026/, "NTU discovery must use the current official degree list");
assert.match(source, /nus-master%27s-degree-by-coursework-tuition-fee-rebate/, "NUS discovery must use an official coursework programme list");
assert.match(source, /Promise\.allSettled/, "One unavailable university must not discard the other catalogue results");
console.log("programme discovery checks passed");
