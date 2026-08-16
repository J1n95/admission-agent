import { listApprovedCases, listCaseEmbeddings, openCaseStore, upsertCaseEmbeddings } from "./store.mjs";
import { buildCaseEmbeddingText, embeddingTextHash, requestEmbeddings, resolveEmbeddingSettings } from "./vector-search.mjs";

try { process.loadEnvFile(".env"); } catch (error) { if (error.code !== "ENOENT") throw error; }

const settings = resolveEmbeddingSettings({ ...process.env, VECTOR_SEARCH_ENABLED: "true" });
const force = process.argv.includes("--force");
const limitArg = process.argv.find(value => value.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number(limitArg.slice("--limit=".length))) : Number.POSITIVE_INFINITY;
const db = openCaseStore();

try {
  const approvedCases = listApprovedCases(db);
  const existing = new Map(listCaseEmbeddings(db).map(item => [item.fingerprint, item]));
  const pending = approvedCases
    .map(item => ({ item, text: buildCaseEmbeddingText(item), textHash: embeddingTextHash(buildCaseEmbeddingText(item)) }))
    .filter(({ item, textHash }) => force || existing.get(item.fingerprint)?.model !== settings.model || existing.get(item.fingerprint)?.textHash !== textHash)
    .slice(0, limit);

  let embedded = 0;
  for (let offset = 0; offset < pending.length; offset += settings.batchSize) {
    const batch = pending.slice(offset, offset + settings.batchSize);
    const vectors = await requestEmbeddings(batch.map(item => item.text), settings);
    upsertCaseEmbeddings(db, vectors.map((vector, index) => ({
      fingerprint: batch[index].item.fingerprint,
      model: settings.model,
      vector,
      textHash: batch[index].textHash
    })));
    embedded += batch.length;
    console.log(JSON.stringify({ event: "embedding-batch", embedded, total: pending.length }));
  }

  console.log(JSON.stringify({
    enabled: settings.enabled,
    model: settings.model,
    approvedCases: approvedCases.length,
    existingEmbeddings: existing.size,
    embedded,
    remaining: Math.max(0, pending.length - embedded),
    force
  }, null, 2));
} finally {
  db.close();
}
