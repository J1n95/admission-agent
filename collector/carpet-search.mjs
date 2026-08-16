import { readFile } from "node:fs/promises";
import { loadSources, collectUrl, canonicalizeCandidateUrl, discoverLinks, discoverEntryLinks, parseSeedCaseCandidates } from "./agent.mjs";
import { defaultDbPath, openCaseStore } from "./store.mjs";

const root = new URL(".", import.meta.url);
const args = process.argv.slice(2);
const numberFlag = (name, fallback) => {
  const value = args.find(arg => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
};
const hasFlag = name => args.includes(`--${name}`);
const maxPages = Math.max(1, numberFlag("max-pages", 12));
const maxDetailsPerSource = Math.max(1, numberFlag("max-details", 160));
const concurrency = Math.max(1, numberFlag("concurrency", 4));
const timeoutMs = Math.max(3000, numberFlag("timeout-ms", 10000));
const sourceStart = Math.max(0, numberFlag("source-start", 0));
const sourceLimit = Math.max(1, numberFlag("sources", Infinity));
const detailLimit = Math.max(1, numberFlag("detail-limit", Infinity));
const userAgent = process.env.COLLECTOR_USER_AGENT || "admission-reference-carpet-search/1.0";

function sourceForUrl(url, sources) {
  try {
    const hostname = new URL(url).hostname;
    return sources.find(source => (source.hosts || []).includes(hostname)) || null;
  } catch {
    return null;
  }
}

function matches(url, patterns = []) {
  try {
    const pathname = new URL(url).pathname;
    return patterns.some(pattern => new RegExp(pattern).test(pathname));
  } catch {
    return false;
  }
}

function uniqueUrls(values) {
  return [...new Set(values.map(value => {
    try { return canonicalizeCandidateUrl(value); } catch { return null; }
  }).filter(Boolean))];
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" }
    });
    return { status: response.status, finalUrl: response.url || url, html: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function mapPool(items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error: error.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function knownUrls(db) {
  return new Set(db.prepare(`
    SELECT source_url AS url FROM cases
    UNION SELECT source_url AS url FROM crawl_sources
  `).all().map(row => {
    try { return canonicalizeCandidateUrl(row.url); } catch { return null; }
  }).filter(Boolean));
}

async function discoverSource(source, seenUrls) {
  const pageQueue = uniqueUrls([...(source.seedUrls || []), ...(source.fallbackUrls || [])]);
  const queuedPages = new Set(pageQueue);
  const visitedPages = new Set();
  const detailUrls = new Set();
  const errors = [];
  let pagesFetched = 0;

  while (pageQueue.length && pagesFetched < maxPages) {
    const pageUrl = pageQueue.shift();
    if (visitedPages.has(pageUrl)) continue;
    visitedPages.add(pageUrl);
    let page;
    try {
      page = await fetchPage(pageUrl);
      pagesFetched += 1;
    } catch (error) {
      errors.push({ url: pageUrl, error: error.message });
      continue;
    }
    if (page.status < 200 || page.status >= 400) {
      errors.push({ url: pageUrl, error: `HTTP ${page.status}` });
      continue;
    }

    const detailCandidates = discoverLinks(page.html, page.finalUrl, source);
    const seedCandidates = uniqueUrls([
      ...discoverEntryLinks(page.html, page.finalUrl, source),
      ...parseSeedCaseCandidates(page.html, page.finalUrl, source, null).map(item => item.url)
    ]);
    const isDetailRoot = matches(page.finalUrl, source.detailRegexes || []);
    if (isDetailRoot) detailCandidates.push(page.finalUrl);
    for (const url of uniqueUrls(detailCandidates)) {
      if (!seenUrls.has(url)) detailUrls.add(url);
    }
    for (const url of seedCandidates) {
      if (!queuedPages.has(url) && !visitedPages.has(url) && pageQueue.length + visitedPages.size < maxPages * 3) {
        queuedPages.add(url);
        pageQueue.push(url);
      }
    }
  }

  return {
    pagesFetched,
    pagesQueued: visitedPages.size + pageQueue.length,
    detailsDiscovered: detailUrls.size,
    detailUrls: [...detailUrls].slice(0, maxDetailsPerSource),
    skippedSeen: 0,
    errors
  };
}

async function main() {
  const sources = (await loadSources()).slice(sourceStart, sourceStart + sourceLimit);
  const db = openCaseStore(defaultDbPath);
  const seenUrls = hasFlag("recheck-seen") ? new Set() : knownUrls(db);
  db.close();
  const report = { startedAt: new Date().toISOString(), config: { maxPages, maxDetailsPerSource, concurrency, sourceStart, sourceLimit, detailLimit, recheckSeen: hasFlag("recheck-seen") }, sources: [], totals: { pagesFetched: 0, detailsDiscovered: 0, detailsAttempted: 0, extracted: 0, queued: 0, approved: 0, errors: 0 } };
  let remaining = detailLimit;

  for (const source of sources) {
    if (remaining <= 0) break;
    const discovered = await discoverSource(source, seenUrls);
    const detailUrls = discovered.detailUrls.slice(0, remaining);
    const results = await mapPool(detailUrls, url => collectUrl(url, sources, {
      dryRun: false,
      forceRefresh: false,
      recheckEmpty: true
    }));
    const summary = {
      sourceId: source.id,
      pagesFetched: discovered.pagesFetched,
      pagesQueued: discovered.pagesQueued,
      detailsDiscovered: discovered.detailsDiscovered,
      detailsAttempted: detailUrls.length,
      extracted: results.reduce((sum, item) => sum + Number(item?.extracted || 0), 0),
      queued: results.reduce((sum, item) => sum + Number(item?.queued || 0), 0),
      approved: results.reduce((sum, item) => sum + (item?.candidates || []).filter(candidate => candidate?.reviewStatus === "approved" && Number(candidate.offerYear) >= 2021).length, 0),
      errors: [...discovered.errors, ...results.filter(item => item?.error).map((item, index) => ({ url: detailUrls[index], error: item.error }))]
    };
    report.sources.push(summary);
    report.totals.pagesFetched += summary.pagesFetched;
    report.totals.detailsDiscovered += summary.detailsDiscovered;
    report.totals.detailsAttempted += summary.detailsAttempted;
    report.totals.extracted += summary.extracted;
    report.totals.queued += summary.queued;
    report.totals.approved += summary.approved;
    report.totals.errors += summary.errors.length;
    remaining -= detailUrls.length;
    for (const url of detailUrls) seenUrls.add(url);
    console.log(JSON.stringify({ source: source.id, ...summary, totals: report.totals }));
  }

  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
