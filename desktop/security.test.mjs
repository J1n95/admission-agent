import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'admission-desktop-auth-'));
copyFileSync(join(root, 'build/desktop-seed/cases-seed.sqlite'), join(directory, 'cases.sqlite'));
process.env.ADMISSION_APP_ROOT = root;
process.env.ADMISSION_DATA_DIR = directory;
process.env.ADMISSION_REFERENCE_DB_PATH = join(root, 'build/desktop-seed/institutions.sqlite');
process.env.ADMISSION_AGENT_DATA_DIR = join(root, 'build/desktop-seed');
process.env.ADMISSION_DESKTOP_TOKEN = 'test-only-desktop-token';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const { httpServer, clearLocalAnalysisData, closeLocalDataStore } = await import('../server.mjs');
if (!httpServer.listening) await once(httpServer, 'listening');
const origin = `http://127.0.0.1:${httpServer.address().port}`;
const headers = { 'X-Admission-Desktop-Token': process.env.ADMISSION_DESKTOP_TOKEN };
let database;
try {
  assert.equal((await fetch(`${origin}/api/health`)).status, 403);
  assert.equal((await fetch(`${origin}/api/health`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/admin.html`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/api/admin/session`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/review.html`)).status, 403);
  assert.equal((await fetch(`${origin}/review.html`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/collector/status`, { headers })).status, 200);
  const collectorOptions = await (await fetch(`${origin}/api/collector/options`, { headers })).json();
  assert.ok(collectorOptions.programmes.length > 100, 'Desktop collector must offer the complete programme catalogue');
  assert.ok(collectorOptions.programmes.some(programme => programme.id === 'hkust-ee'));
  const home = await fetch(`${origin}/`, { headers });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /href="\/review\.html">案例采集与审核<\/a>/);
  const displayModule = await fetch(`${origin}/display-evidence.mjs`, { headers });
  assert.equal(displayModule.status, 200);
  assert.match(await displayModule.text(), /readableEvidenceIds/);
  const schoolTierModule = await fetch(`${origin}/verified-double-first-class.mjs`, { headers });
  assert.equal(schoolTierModule.status, 200, 'The page must load the school-tier module imported by case-analysis');
  assert.match(await schoolTierModule.text(), /verified-double-first-class/);
  const schoolTierData = await fetch(`${origin}/miniprogram/cloudfunctions/admissionApi/agent/verified-double-first-class.mjs`, { headers });
  assert.equal(schoolTierData.status, 200, 'The re-exported school-tier data must also be public');
  assert.match(await schoolTierData.text(), /doubleFirstClassOnlyNames/);
  const institutions = await (await fetch(`${origin}/api/institutions/search?q=${encodeURIComponent('成都理工大学')}`, { headers })).json();
  assert.ok(institutions.results.some(item => item.nameZh === '成都理工大学' && item.classification === '双一流'));

  database = new DatabaseSync(join(directory, 'cases.sqlite'));
  database.prepare("INSERT INTO analysis_records (id, status, applicant_json, created_at) VALUES ('desktop-test', 'complete', '{}', '2026-01-01')").run();
  database.prepare("INSERT INTO analysis_feedback (analysis_id, answers_json, created_at) VALUES ('desktop-test', '{}', '2026-01-01')").run();
  clearLocalAnalysisData();
  assert.equal(database.prepare('SELECT count(*) AS n FROM analysis_records').get().n, 0);
  assert.equal(database.prepare('SELECT count(*) AS n FROM analysis_feedback').get().n, 0);
  console.log('desktop loopback access, admin isolation, and local record deletion passed');
} finally {
  database?.close();
  await new Promise((resolveClose, rejectClose) => httpServer.close(error => error ? rejectClose(error) : resolveClose()));
  closeLocalDataStore();
  rmSync(directory, { recursive: true, force: true });
}
