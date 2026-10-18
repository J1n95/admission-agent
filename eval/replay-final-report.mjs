import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeProbabilityCalibration,
  normalizeAgentAssessments,
  normalizeProbabilityCalibration
} from '../miniprogram/cloudfunctions/admissionApi/agent/runtime.mjs';

export function replayFinalReport(run) {
  const records = run.results || [];
  const reports = [];
  for (const selection of records.filter(item => item.stage === 'selection' && item.scenario.startsWith('cross-'))) {
    const prefix = selection.scenario.slice(0, -'-selection'.length);
    const ranking = records.find(item => item.scenario === `${prefix}-ranking`);
    const assessments = records.filter(item => item.scenario.startsWith(`${prefix}-assessment-`));
    assert.ok(ranking?.parsed && assessments.length > 0, `${prefix}: missing ranking output or assessments`);
    const rankingInput = JSON.parse(ranking.request.messages[1].content);
    const prepared = { modelInput: { profile: rankingInput.profile, programmes: rankingInput.programmes } };
    const calibration = normalizeProbabilityCalibration(ranking.parsed, prepared);
    const calibrationValid = Object.keys(calibration).length === rankingInput.programmes.length;
    const normalized = {};
    for (const record of assessments) {
      const input = JSON.parse(record.request.messages[1].content);
      const programme = input.programmes[0];
      assert.equal(programme.id, record.programmeId);
      const context = {
        comparisons: [{ programme: { id: programme.id }, result: { evidence: programme.caseDistribution } }],
        modelInput: { programmes: [programme] },
        evidenceSelections: { [programme.id]: programme.evidenceSelection.map(id => ({ id })) }
      };
      const assessment = normalizeAgentAssessments(record.parsed.assessments, context)[programme.id];
      assert.ok(assessment, `${record.scenario}: current assessment normalization failed`);
      normalized[programme.id] = assessment;
    }
    const merged = mergeProbabilityCalibration(normalized, calibration, prepared);
    const selected = selection.parsed?.selectedProgrammeIds || [];
    const rows = Object.entries(merged).map(([id, item]) => ({
      id,
      name: rankingInput.programmes.find(programme => programme.id === id)?.nameZh
        || rankingInput.programmes.find(programme => programme.id === id)?.name || id,
      selectedByCardScreening: selected.includes(id),
      caseCount: rankingInput.programmes.find(programme => programme.id === id)?.caseDistribution?.caseCount ?? null,
      center: item.center, low: item.low, high: item.high,
      probabilityRank: item.probabilityRank,
      confidence: item.confidence,
      basis: item.probabilityBasis,
      assessmentOriginallyRejected: assessments.find(record => record.programmeId === id)?.contractValid === false,
      fit: item.fit, psCv: item.psCv, reasoning: item.reasoning,
      uncertainties: item.uncertainties,
      evidenceUsed: item.evidenceUsed
    })).sort((a, b) => b.center - a.center);
    if (calibrationValid) {
      assert.ok(rows.every((row, index) => row.probabilityRank === index + 1), `${prefix}: displayed order and calibrated rank disagree`);
    }
    reports.push({ profile: prefix, calibrationValid, rows });
  }
  return reports;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  assert.ok(files.length, 'usage: node eval/replay-final-report.mjs <results.json> [...]');
  for (const file of files) {
    const run = JSON.parse(readFileSync(resolve(file), 'utf8'));
    console.log(JSON.stringify({ source: resolve(file), reports: replayFinalReport(run) }, null, 2));
  }
}
