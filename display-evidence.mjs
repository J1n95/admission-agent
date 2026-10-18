export function readableEvidenceIds(value) {
  return String(value ?? "").replace(/\s*\[(?:e|c)_[A-Za-z0-9_-]+\]\s*/g, "").trim();
}
