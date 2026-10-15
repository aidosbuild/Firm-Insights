// scripts/check-stale.mjs
//
// Runs as the workflow's last step, after data.json is committed (so fresh data
// still deploys). Prints every firm's status and exits 1 — failing the run, so
// GitHub emails the repo owner — when a scraped firm hasn't returned articles
// for more than STALE_DAYS. Manual-only firms are skipped.
//
// Usage: node scripts/check-stale.mjs

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data.json");
const STALE_DAYS = 7;
const DAY_MS = 86400000;

const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
const now = Date.now();
const stale = [];

for (const f of data.firms || []) {
  if (f.manualOnly) continue;
  const okMs = f.lastOkAt ? Date.parse(f.lastOkAt) : NaN;
  const days = Number.isNaN(okMs) ? null : Math.floor((now - okMs) / DAY_MS);
  const last = days === null ? "never (since status tracking began)" : `${days} day(s) ago`;
  const line =
    `${f.name}: last returned articles ${last}` +
    (f.keptPrevious ? "; showing its previous list" : "") +
    (f.lastError ? `; last error: ${f.lastError}` : "");
  console.log(`  ${line}`);
  if (days === null || days > STALE_DAYS) stale.push(line);
}

if (stale.length) {
  console.error(`\n${stale.length} firm(s) haven't returned articles for over ${STALE_DAYS} days:`);
  for (const s of stale) console.error(`  - ${s}`);
  console.error("Their previous articles are still shown. Check each firm's adapter in scripts/firms/.");
  process.exit(1);
}
console.log(`All scraped firms returned articles within the last ${STALE_DAYS} days.`);
