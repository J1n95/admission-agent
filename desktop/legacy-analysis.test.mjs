import assert from "node:assert/strict";
import { test } from "node:test";
import { citedEvidenceSnapshots, displayProgramme, runWithConcurrency } from "./legacy-analysis.mjs";

test("review shows only evidence cited by the model and retains source labels", () => {
  const snapshots = citedEvidenceSnapshots([
    { id: "official-1", title: "申请要求", provenance: "official-structured", text: "IELTS 6.5", metadata: { checkedAt: "2026-08-15" } },
    { id: "case-1", title: "成功案例", provenance: "public-case", text: "GPA 85", metadata: {} },
    { id: "case-2", title: "未引用案例", provenance: "public-case", text: "GPA 90" }
  ], [{ documentId: "official-1" }, { documentId: "case-1" }]);
  assert.deepEqual(snapshots.map(item => item.id), ["official-1", "case-1"]);
  assert.equal(snapshots[0].checkedAt, "2026-08-15");
  assert.equal(snapshots[1].provenance, "public-case");
  assert.equal(snapshots[1].checkedAt, null);
});

test("existing official snapshot fills empty display fields without treating AI derivation as official", () => {
  const programme = { id: "example", university: "学校", nameEn: "项目", requirements: "", positioning: "" };
  const rows = [
    { section: "requirements", provenance: "official-structured", text: "本科专业要求", checkedAt: "2026-08-15T00:00:00Z" },
    { section: "positioning", provenance: "official-structured", text: "项目定位", checkedAt: "2026-08-15T00:00:00Z" },
    { section: "career", provenance: "derived-ai", text: "AI推断就业" }
  ];
  const displayed = displayProgramme(programme, [], rows);
  assert.equal(displayed.officialNote, "本科专业要求");
  assert.equal(displayed.overview, "项目定位");
  assert.equal(displayed._programmeEvidenceSnapshot, "2026-08-15");
  assert.equal(displayed._programmeProvenance.requirements, "official-structured-snapshot");
  assert.equal(displayed.career, undefined);
});

test("existing card content is not replaced by evidence snapshot", () => {
  const displayed = displayProgramme({ requirements: "已有内容" }, [], [
    { section: "requirements", provenance: "official-structured", text: "快照内容" }
  ]);
  assert.equal(displayed.officialNote, "已有内容");
});

test("model work is capped to two concurrent requests", async () => {
  let active = 0;
  let peak = 0;
  const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map(item => item.value), [2, 4, 6, 8, 10]);
});
