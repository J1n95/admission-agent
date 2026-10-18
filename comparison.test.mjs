import assert from "node:assert/strict";
import { test } from "node:test";
import { buildComparison } from "./comparison.mjs";

const item = (id, center, count, valid = true) => ({
  programme: { id, caseCount: count },
  result: { assessmentAvailable: valid, center, low: Math.max(0, center - 20), high: Math.min(100, center + 20) }
});

test("relative order follows model references from high to low", () => {
  const comparison = buildComparison([item("low", 30, 9), item("top", 70, 6), item("mid", 50, 4)]);
  assert.deepEqual(comparison.ordered.map(row => row.programme.id), ["top", "mid", "low"]);
  assert.deepEqual(comparison.byId.get("top"), { rank: 1, total: 3 });
});

test("ties share a rank and invalid outputs are excluded", () => {
  const comparison = buildComparison([item("a", 60, 0), item("b", 60, 6), item("c", 20, 4), item("d", 80, 5, false)]);
  assert.equal(comparison.total, 3);
  assert.equal(comparison.byId.get("a").rank, 1);
  assert.equal(comparison.byId.get("b").rank, 1);
  assert.equal(comparison.byId.has("d"), false);
});

test("one assessed project remains displayable", () => {
  const comparison = buildComparison([item("only", 55, 20)]);
  assert.deepEqual(comparison.byId.get("only"), { rank: 1, total: 1 });
});
