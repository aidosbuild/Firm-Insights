// scripts/firms/corrs.mjs
//
// Corrs Chambers Westgarth — Australian firm. Two sources, merged:
//  1) Elastic App Search (Swiftype) JSON API — the full back-catalogue,
//     newest-first, with clean title/url/date/teaser. Uses the site's public
//     search key (embedded in their app.js). NOTE: this index lags ~4 months.
//  2) The server-rendered /insights homepage cards (UIkit) — the freshest
//     items the search index hasn't picked up yet.
// Relevance is decided by the shared competition/consumer filter.

import { load } from "cheerio";
import { fetchJson, fetchText, politeFetch, clean, sleep, REQUEST_DELAY_MS, parseDateToISO } from "../lib/shared.mjs";
import { withPage } from "../lib/browser.mjs";

const short = (err) => String((err && err.message) || err).split(" for ")[0];

const ORIGIN = "https://www.corrs.com.au";
const SWIFTYPE =
  "https://host-67byae.api.swiftype.com/api/as/v1/engines/corrs-site-search-pre-prod/search";
const SEARCH_KEY = "search-e84uht5ow3117df9upxe6pc9"; // public search-only key
// The firm's own competition/consumer practice classifications — every insight
// under these is INCLUDED (over-include).
const COMPETITION_CAPS = ["Competition", "Competition/Antitrust Advice and Compliance"];

async function query(body) {
  return fetchJson(SWIFTYPE, {
    method: "POST",
    headers: { Authorization: `Bearer ${SEARCH_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function pushResult(r, out, seen, extra) {
  const title = clean(r?.title?.raw);
  let uri = clean(r?.uri?.raw);
  if (!title || !uri) return;
  const url = uri.startsWith("http") ? uri : `${ORIGIN}/${uri.replace(/^\//, "")}`;
  if (seen.has(url)) return;
  seen.add(url);
  const tags = [].concat(r?.related_capabilities?.raw || []).concat(r?.tags?.raw || []);
  out.push({
    title,
    url,
    dateISO: (clean(r?.published_at?.raw) || "").slice(0, 10) || null,
    teaser: clean(r?.summary?.raw),
    tags: Array.isArray(tags) ? tags : [tags].filter(Boolean),
    ...extra,
  });
}

// 1) Everything filed under Corrs' Competition capabilities → include all.
async function fetchByCapability(out, seen) {
  for (let page = 1; page <= 4; page++) {
    let json;
    try {
      json = await query({
        query: "",
        page: { size: 100, current: page },
        filters: { all: [{ type: "insight" }, { related_capabilities: COMPETITION_CAPS }] },
        sort: [{ published_at_unix: "desc" }],
      });
    } catch { break; }
    const results = json?.results || [];
    if (!results.length) break;
    for (const r of results) pushResult(r, out, seen, { preFiltered: true, defaultTopics: ["Competition"] });
    if (page >= Number(json?.meta?.page?.total_pages || 0)) break;
    await sleep(REQUEST_DELAY_MS);
  }
}

// 2) Recent insights across all capabilities → keyword filter catches consumer
//    / ACL items that aren't tagged to the Competition capability.
async function fetchRecent(out, seen) {
  for (let page = 1; page <= 3; page++) {
    let json;
    try {
      json = await query({
        query: "",
        page: { size: 100, current: page },
        filters: { type: "insight" },
        sort: [{ published_at_unix: "desc" }],
      });
    } catch { break; }
    const results = json?.results || [];
    if (!results.length) break;
    for (const r of results) pushResult(r, out, seen, {});
    if (page >= Number(json?.meta?.page?.total_pages || 0)) break;
    await sleep(REQUEST_DELAY_MS);
  }
}

/**
 * Read a Corrs article's publication date (ISO): JSON-LD first, then the
 * visible <p class="postDate">11 September 2026</p> (the July 2026 redesign
 * dropped the JSON-LD). Section pages have neither and stay undated.
 */
function dateFromHtml(html) {
  const m = /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(html);
  if (m) return m[1];
  return parseDateToISO(load(html)("p.postDate").first().text());
}

/** ISO date, null when the page has none, undefined when the page was refused. */
async function fetchDateISO(url) {
  try {
    const res = await politeFetch(url);
    return dateFromHtml(await res.text());
  } catch {
    return undefined;
  }
}

async function mapPool(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Freshest items straight off the SSR listing (covers the index's ~4-month lag).
// The listing has no dates, so we read each new article's date (cached across
// runs via previousByUrl). These go through the shared keyword filter.
// GitHub's servers are sometimes refused plain requests (Oct 2026: the live
// site stopped finding these while a normal connection still did), so a
// refused page falls back to the workflow's headless browser, and refusals are
// reported (lastError) rather than swallowed.
async function fetchHomepage(out, seen, previousByUrl, errors) {
  let html;
  try {
    html = await fetchText(`${ORIGIN}/insights`);
  } catch (err) {
    errors.push(`insights page: ${short(err)}`);
    try {
      html = await withPage(`${ORIGIN}/insights`, (page) => page.content());
    } catch (err2) {
      errors.push(`insights page (browser): ${short(err2)}`);
      return;
    }
  }
  const $ = load(html);
  const fresh = [];
  $("a[href*='/insights/']").each((_, el) => {
    const a = $(el);
    const href = a.attr("href") || "";
    if (!/\/insights\/[a-z0-9-]{6,}/i.test(href)) return; // article, not hub
    const url = href.startsWith("http") ? href : ORIGIN + href;
    if (seen.has(url)) return;
    // The card's bold title line, not the link's whole text: since the July
    // 2026 redesign the link also holds an uppercase type label ("article").
    const title = clean(a.find("p.uk-text-bold").first().text()) || clean(a.text());
    if (!title || title.length < 12) return;
    seen.add(url);
    const card = a.closest(".uk-card, li, article, div");
    // Skip the label and the title line (new cards have no teaser at all).
    const teaser = clean(card.find("p").not(".uk-text-uppercase").not(".uk-text-bold").first().text());
    fresh.push({ title, url, teaser });
  });

  const refused = [];
  await mapPool(fresh, 6, async (it) => {
    const prev = previousByUrl && previousByUrl.get(it.url);
    if (prev && prev.dateISO) { it.dateISO = prev.dateISO; return; }
    const d = await fetchDateISO(it.url);
    if (d === undefined) refused.push(it);
    else it.dateISO = d;
  });
  if (refused.length) {
    errors.push(`${refused.length} article page(s) refused; used the headless browser`);
    try {
      await withPage(`${ORIGIN}/insights`, async (page) => {
        for (const it of refused) {
          const h = await page.evaluate(async (u) => {
            const r = await fetch(u);
            return r.ok ? r.text() : "";
          }, it.url);
          it.dateISO = h ? dateFromHtml(h) : null;
        }
      });
    } catch (err) {
      errors.push(`article pages (browser): ${short(err)}`);
    }
  }
  for (const it of fresh) out.push(it);
}

async function fetchRecords({ previousByUrl } = {}) {
  const out = [];
  const seen = new Set();
  const errors = [];
  await fetchByCapability(out, seen);
  await fetchRecent(out, seen);
  await fetchHomepage(out, seen, previousByUrl, errors);
  out.errors = errors;
  return out;
}

export default {
  name: "Corrs Chambers Westgarth",
  order: 11,
  badge: { initial: "C", color: "#c8102e" },
  sourceUrl: "https://www.corrs.com.au/insights",
  domestic: true,
  fetchRecords,
};
