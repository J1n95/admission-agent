export function readableEvidenceIds(value) {
  return String(value ?? "").replace(/\s*\[(?:(?:e|c)_[A-Za-z0-9_-]+|[a-f0-9]{16,64})\]\s*/gi, "").trim();
}
