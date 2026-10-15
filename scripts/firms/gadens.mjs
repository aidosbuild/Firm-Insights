// scripts/firms/gadens.mjs
//
// Gadens — https://www.gadens.com/insights
// Gadens rebuilt its site on Squiz DXP in 2026: the old WordPress AJAX listing
// and the /legal-insights/ addresses are gone (404), and www.gadens.com blocks
// plain scripted requests. Its insights page is driven by Squiz's hosted
// Funnelback search (the page's data-lookup-url), which answers plain JSON:
//   GET https://dxp03-au-search.funnelback.squiz.cloud/s/search.json
//       ?collection=gade~sp-site-search&profile=site-search-results_preview
//       &query=!padrenull&f.Type|pageType=insights&sort=dmetadate&num_ranks=200
// Two passes, merged:
//  1) The firm's "Competition and market regulation" service → include all
//     (over-include).
//  2) All insights (~130, one page) → the shared keyword filter decides.
// Each result has title, liveUrl, listMetadata.date ("2026-10-09T00:00:00+11:00",
// Sydney time, so the first 10 characters are the date) and a description.

import { fetchJson, clean } from "../lib/shared.mjs";

const SEARCH = "https://dxp03-au-search.funnelback.squiz.cloud/s/search.json";
const SERVICE = "competition and market regulation";

function search(extra) {
  const params = new URLSearchParams({
    collection: "gade~sp-site-search",
    profile: "site-search-results_preview",
    query: "!padrenull", // Funnelback's "match everything" query
    "f.Type|pageType": "insights",
    sort: "dmetadate",
    num_ranks: "200",
    ...extra,
  });
  return fetchJson(`${SEARCH}?${params}`);
}

async function fetchRecords() {
  const out = [];
  const seen = new Set();
  const errors = [];
  const push = (r, extra) => {
    const title = clean(r?.title);
    const url = clean(r?.liveUrl);
    if (!title || !url || seen.has(url)) return;
    seen.add(url);
    const md = r.listMetadata || {};
    out.push({
      title,
      url,
      dateISO: (md.date?.[0] || "").slice(0, 10) || null,
      teaser: clean(md.description?.[0] || r.summary),
      ...extra,
    });
  };

  // 1) The Competition and market regulation service — include all.
  try {
    const json = await search({ "f.Services|services": SERVICE });
    for (const r of json?.response?.resultPacket?.results || []) {
      push(r, { preFiltered: true, defaultTopics: ["Competition & Consumer"] });
    }
  } catch (err) { errors.push(`service search: ${err.message}`); }

  // 2) All insights — keyword filter decides.
  try {
    const json = await search({});
    for (const r of json?.response?.resultPacket?.results || []) push(r, {});
  } catch (err) { errors.push(`all insights: ${err.message}`); }

  out.errors = errors;
  return out;
}

export default {
  name: "Gadens",
  order: 10,
  badge: { initial: "G", color: "#3f9c35" },
  sourceUrl: "https://www.gadens.com/insights",
  domestic: true,
  fetchRecords,
};
