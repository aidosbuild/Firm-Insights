// scripts/scrape.mjs
//
// Shared runner. Iterates every firm adapter, applies the shared relevance +
// jurisdiction filters, merges the manual layer, dedupes by URL, and writes
// data.json shaped as { generatedAt, firms: [{ name, badge, records:[...] }] }.
//
// Robustness (see README):
//  - A broken firm never blanks the site: if a firm errors OR returns 0 where
//    it previously had records, we KEEP that firm's previous records.
//  - We only write data.json when something actually changed.
//  - Per-firm counts are logged (found / kept-AU / kept-relevant / dropped).
//  - Each firm carries a status — lastOkAt (when it last returned articles),
//    keptPrevious, lastError — so a firm that keeps failing is visible
//    (scripts/check-stale.mjs fails the workflow after 7 days). An adapter may
//    attach `errors` (strings) to the array it returns, for failures it
//    swallowed while still returning something.
//
// Usage: node scripts/scrape.mjs
// Exit codes: 0 = success (written or unchanged), 1 = fatal (last good kept).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ADAPTERS } from "./firms/index.mjs";
import {
  clean,
  parseDateToISO,
  dateFieldsFromISO,
  assessRelevance,
  hasAuSignal,
  hasForeignSignal,
} from "./lib/shared.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_PATH = join(ROOT, "data.json");
const MANUAL_PATH = join(ROOT, "manual-entries.json");

// Only keep scraped articles published on/after this date (ISO YYYY-MM-DD).
// Undated scraped items can't be placed in the window, so they are dropped.
const START_DATE = process.env.START_DATE || "2026-01-01";

// ---------------------------------------------------------------------------
// Normalisation + filtering of one adapter's raw records
// ---------------------------------------------------------------------------

function normaliseRecord(raw, adapter) {
  const title = clean(raw.title);
  const url = clean(raw.url);
  if (!title || !url) return null;

  const iso = raw.dateISO || parseDateToISO(raw.dateRaw || raw.date || "");
  const df = dateFieldsFromISO(iso);

  // Text we scan for relevance + jurisdiction.
  const blob = [title, raw.teaser, raw.topicHint, (raw.tags || []).join(" ")]
    .filter(Boolean)
    .join(" — ");

  const assessed = assessRelevance(blob);

  // OVER-INCLUDE: when a record comes from a firm's OWN competition/consumer/
  // trade practice filter (raw.preFiltered), we trust that classification and
  // include it regardless of our keyword engine. Jurisdiction + date window
  // still apply. We keep any keyword-derived topics for display, and fall back
  // to the adapter's default topic (e.g. "Competition & Consumer") if none.
  const preFiltered = raw.preFiltered === true;
  const relevant = preFiltered ? true : assessed.relevant;

  let topicList = [...new Set([...(raw.topics || []), ...assessed.topics])];
  if (preFiltered && topicList.length === 0) {
    topicList = raw.defaultTopics && raw.defaultTopics.length
      ? raw.defaultTopics
      : ["Competition & Consumer"];
  }
  // Split any comma-joined label so the article is tagged under EACH topic.
  topicList = [
    ...new Set(
      topicList.flatMap((t) => String(t).split(",").map((s) => s.trim())).filter(Boolean)
    ),
  ];

  return {
    firm: adapter.name,
    title,
    permalink: url,
    dateISO: df.dateISO,
    dateText: df.dateText,
    month: df.month,
    year: df.year,
    topic: topicList.join(", "),
    topics: topicList,
    teaser: clean(raw.teaser || ""),
    summary: "", // reserved: 3–4 bullet summary can be filled in later
    bullets: [], // reserved
    _relevant: relevant,
    _blob: blob,
    _auHint: raw.auHint === true,
    overridden: false,
    notes: "",
  };
}

/** Apply relevance + (for international firms) jurisdiction filters. */
function filterRecords(records, adapter, counters) {
  const kept = [];
  for (const r of records) {
    if (!r) continue;
    counters.found++;

    // Date window: keep only items on/after START_DATE. Undated → drop.
    if (!r.dateISO || r.dateISO < START_DATE) {
      counters.droppedDate++;
      continue;
    }

    // Jurisdiction:
    //  - International firms must show an Australian signal (URL/office/text).
    //  - Domestic Australian firms pass by default, BUT are dropped when a
    //    piece is plainly about another country with no Australian tie (these
    //    firms also run Asia/UK/US practices).
    let auOk;
    if (adapter.domestic === true) {
      // The firm's own domain is always .com.au, so ignore the URL here and
      // judge on the TEXT: keep unless the piece is plainly foreign.
      auOk = hasAuSignal({ text: r._blob }) || !hasForeignSignal({ text: r._blob });
    } else {
      // International firm: an /au/ or en-au URL path is a valid AU signal.
      auOk = r._auHint || hasAuSignal({ text: r._blob, url: r.permalink });
    }
    if (!auOk) {
      counters.droppedJurisdiction++;
      continue;
    }
    counters.keptAu++;

    // Relevance: competition and/or consumer law (lean to include).
    if (!r._relevant) {
      counters.droppedTopic++;
      continue;
    }
    counters.keptRelevant++;
    kept.push(r);
  }
  return kept;
}

function stripInternals(r) {
  const { _relevant, _blob, _auHint, ...clean } = r;
  return clean;
}

function dedupeByUrl(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const key = r.permalink.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function sortNewestFirst(records) {
  return records.slice().sort((a, b) => {
    const av = a.dateISO || "";
    const bv = b.dateISO || "";
    if (av < bv) return 1;
    if (av > bv) return -1;
    return (a.title || "").localeCompare(b.title || "");
  });
}

// ---------------------------------------------------------------------------
// Manual / curated layer (manual-entries.json)
// ---------------------------------------------------------------------------
// Shape: { "Firm Name": [ { title, url, date|dateISO, topic|topics, teaser } ], ... }
// Entries are deep-merged in (deduped by URL, manual wins on collision) so
// firms that can't be reliably scraped can still be hand-added.

async function loadManual() {
  try {
    const raw = JSON.parse(await readFile(MANUAL_PATH, "utf8"));
    const out = {};
    for (const [firm, entries] of Object.entries(raw)) {
      if (firm.startsWith("_")) continue;
      if (Array.isArray(entries)) out[firm] = entries;
    }
    return out;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.warn(`Could not read manual-entries.json: ${err.message}`);
    return {};
  }
}

function manualToRecords(entries, adapter) {
  return entries
    .map((e) => {
      const iso = e.dateISO || parseDateToISO(e.date || "");
      const df = dateFieldsFromISO(iso);
      const topics = [
        ...new Set(
          (e.topics || (e.topic ? [e.topic] : []))
            .flatMap((t) => String(t).split(",").map((s) => s.trim()))
            .filter(Boolean)
        ),
      ];
      if (!e.title || !e.url) return null;
      return {
        firm: adapter.name,
        title: clean(e.title),
        permalink: clean(e.url),
        dateISO: df.dateISO,
        dateText: df.dateText,
        month: df.month,
        year: df.year,
        topic: topics.join(", "),
        topics,
        teaser: clean(e.teaser || ""),
        summary: e.summary || "",
        bullets: Array.isArray(e.bullets) ? e.bullets : [],
        overridden: true,
        notes: e.notes || "Manually added",
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(DATA_PATH, "utf8"));
  } catch {
    return null;
  }
}

function prevFirmRecords(previous, name) {
  if (!previous?.firms) return [];
  const f = previous.firms.find((x) => x.name === name);
  return f?.records || [];
}

async function main() {
  const runAt = new Date().toISOString();
  const previous = await loadPrevious();
  const manual = await loadManual();

  const firms = [];
  let totalRecords = 0;

  for (const adapter of ADAPTERS) {
    const counters = {
      found: 0, keptAu: 0, keptRelevant: 0,
      droppedDate: 0, droppedJurisdiction: 0, droppedTopic: 0,
    };
    let records = null;
    let usedPrevious = false;
    let lastError = null;

    // Previous records for this firm, indexed by URL — passed to the adapter so
    // it can reuse cached fields (e.g. dates that need a per-article fetch).
    const prev = prevFirmRecords(previous, adapter.name);
    const previousByUrl = new Map(prev.map((r) => [r.permalink, r]));
    const prevFirm = previous?.firms?.find((x) => x.name === adapter.name);

    try {
      const raw = await adapter.fetchRecords({ previousByUrl });
      if (raw?.errors?.length) {
        lastError = raw.errors.join("; ");
        console.warn(`  [${adapter.name}] partial errors: ${lastError}`);
      }
      const normalised = (raw || []).map((r) => normaliseRecord(r, adapter));
      records = filterRecords(normalised, adapter, counters);
    } catch (err) {
      console.warn(`  [${adapter.name}] ERROR: ${err.message}`);
      lastError = err.message;
      records = null;
    }

    // Merge the manual layer for this firm.
    const manualRecs = manual[adapter.name] ? manualToRecords(manual[adapter.name], adapter) : [];

    // Robustness: keep this firm's previous records when the scrape THREW
    // (records === null) OR came back empty while we had records before. Many
    // adapters swallow their own fetch errors and return [] instead of throwing,
    // so a sudden 0 is almost always a scrape hiccup (datacenter-IP block, 429,
    // changed markup) — not the firm genuinely deleting everything. Without this
    // guard, one bad run silently wipes the firm. Kept records still satisfy the
    // date window.
    const prevScraped = prev.filter(
      (r) => !r.overridden && r.dateISO && r.dateISO >= START_DATE
    );
    if (records === null || (records.length === 0 && prevScraped.length > 0)) {
      usedPrevious = true;
      lastError = lastError || "Returned no articles; kept the previous list";
      records = [...manualRecs, ...prevScraped];
    } else {
      records = [...manualRecs, ...records];
    }
    // OK = this run's own scrape produced articles (manual entries don't count).
    const scrapedOk = !usedPrevious && records.length > manualRecs.length;

    records = sortNewestFirst(dedupeByUrl(records)).map(stripInternals);
    totalRecords += records.length;

    firms.push({
      name: adapter.name,
      order: adapter.order,
      badge: adapter.badge,
      sourceUrl: adapter.sourceUrl,
      domestic: adapter.domestic === true,
      manualOnly: adapter.manualOnly === true,
      lastOkAt: scrapedOk ? runAt : prevFirm?.lastOkAt ?? null,
      keptPrevious: usedPrevious,
      lastError,
      records,
    });

    console.log(
      `  [${adapter.name}] found ${counters.found}, kept-AU ${counters.keptAu}, ` +
        `kept-relevant ${counters.keptRelevant}, dropped ` +
        `${counters.droppedDate}(pre-${START_DATE})+${counters.droppedJurisdiction}(juris)+${counters.droppedTopic}(topic)` +
        (manualRecs.length ? `, +${manualRecs.length} manual` : "") +
        ` → ${records.length} shown` +
        (usedPrevious ? "  [kept previous — scrape failed/empty]" : "")
    );
  }

  firms.sort((a, b) => (a.order || 0) - (b.order || 0));

  // Change detection: compare only the firm records themselves.
  const signature = (fs) =>
    JSON.stringify(fs.map((f) => ({ name: f.name, records: f.records })));
  const contentChanged = !(previous?.firms && signature(previous.firms) === signature(firms));

  // generatedAt = when content last changed (preserved on quiet runs).
  // lastCheckedAt = this run's time (bumped every run → live heartbeat).
  const now = new Date().toISOString();
  const generatedAt = contentChanged ? now : (previous && previous.generatedAt) || now;

  const out = {
    generatedAt,
    lastCheckedAt: now,
    recordCount: totalRecords,
    firms,
  };
  await writeFile(DATA_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(
    contentChanged
      ? `Wrote data.json — content changed. ${firms.length} firms, ${totalRecords} records.`
      : `Wrote data.json — heartbeat only (no new articles). ${totalRecords} records.`
  );
}

main().catch((err) => {
  console.error("SCRAPE FAILED:", err.message);
  console.error("Last good data.json has been kept unchanged.");
  process.exit(1);
});
