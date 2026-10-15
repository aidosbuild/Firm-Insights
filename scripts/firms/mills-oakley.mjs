// scripts/firms/mills-oakley.mjs
//
// Mills Oakley — Australian, WordPress. Custom post type `insights`, filtered by
// the "Competition, Regulatory and Risk" expertise (term id 6). We include ALL
// of that practice (over-include) PLUS a keyword pass over recent insights to
// catch consumer-law pieces filed elsewhere.
//   /wp-json/wp/v2/insights?expertise=6&per_page=100

import { fetchJson, stripHtml, clean } from "../lib/shared.mjs";

const ORIGIN = "https://www.millsoakley.com.au";

function mapPost(p, extra) {
  const title = stripHtml(p?.title?.rendered);
  const url = clean(p?.link);
  if (!title || !url) return null;
  return {
    title,
    url,
    dateISO: (p.date || "").slice(0, 10) || null,
    teaser: stripHtml(p?.excerpt?.rendered),
    ...extra,
  };
}

async function fetchRecords() {
  const out = [];
  const seen = new Set();
  const push = (rec) => {
    if (rec && !seen.has(rec.url)) { seen.add(rec.url); out.push(rec); }
  };
  // Failures swallowed below are reported to the runner (it records lastError):
  // Mills Oakley sometimes answers CI with a block page instead of JSON.
  const errors = [];

  // 1) The firm's Competition/Regulatory practice — include all.
  try {
    const comp = await fetchJson(
      `${ORIGIN}/wp-json/wp/v2/insights?expertise=6&per_page=100&_fields=id,date,link,title,excerpt`
    );
    (comp || []).forEach((p) => push(mapPost(p, { preFiltered: true, defaultTopics: ["Competition & Consumer"] })));
  } catch (err) { errors.push(`practice feed: ${err.message}`); /* keep going */ }

  // 2) Recent insights across all practices — keyword filter catches the rest.
  for (let page = 1; page <= 2; page++) {
    let batch;
    try {
      batch = await fetchJson(
        `${ORIGIN}/wp-json/wp/v2/insights?per_page=100&page=${page}&orderby=date&order=desc&_fields=id,date,link,title,excerpt`
      );
    } catch (err) { errors.push(`recent page ${page}: ${err.message}`); break; }
    if (!Array.isArray(batch) || batch.length === 0) break;
    batch.forEach((p) => push(mapPost(p, {})));
    if (batch.length < 100) break;
  }
  out.errors = errors;
  return out;
}

export default {
  name: "Mills Oakley",
  order: 18,
  badge: { initial: "M", color: "#e35205" },
  sourceUrl: "https://www.millsoakley.com.au/recent-insights/",
  domestic: true,
  fetchRecords,
};
