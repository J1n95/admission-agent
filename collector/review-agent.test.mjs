import assert from "node:assert/strict";
import { isCorroboratedReview, normalizeReviewDecision, reviewInput } from "./review-agent.mjs";

const decision = normalizeReviewDecision({
  decision: "approved",
  confidence: "high",
  reason: "硬字段均有原文证据",
  evidence: [{ field: "gpaRaw", quote: "GPA 3.8" }]
});
assert.equal(decision.decision, "approved");
assert.equal(decision.evidence[0].field, "gpaRaw");
assert.equal(normalizeReviewDecision({ decision: "delete", confidence: "certain" }).decision, "pending");
assert.equal(isCorroboratedReview([], decision), false);
const evidencedDecision = { ...decision, evidence: [...decision.evidence, { field: "offerYear", quote: "2026" }] };
assert.equal(isCorroboratedReview([{ reviewer: "llm", decision: evidencedDecision }], evidencedDecision), true);
assert.equal(isCorroboratedReview([{ reviewer: "llm", decision: evidencedDecision }], { ...evidencedDecision, decision: "rejected" }), false);
assert.equal(reviewInput({ targetProgramme: "EE", sourceUrl: "https://example.com" }, "text").sourceText, "text");
console.log("review-agent checks passed");
