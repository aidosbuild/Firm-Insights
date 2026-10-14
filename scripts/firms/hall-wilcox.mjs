// scripts/firms/hall-wilcox.mjs
//
// Hall & Wilcox — Australian (Next.js + Craft CMS GraphQL). Articles are fetched
// via GraphQL in two passes:
//  1) The firm's "Competition and Consumer Law" service (entry id 15647) →
//     include all (over-include):
//       POST /api/graphql/  entries(section:["article"], relatedToEntries:[{id:[15647]}])
//  2) The newest 100 articles across all services → the shared keyword filter
//     catches competition/consumer pieces not tagged to that service (few are).
// Fields: title / url / postDate ("j M Y") / summary.

import { fetchJson, clean } from "../lib/shared.mjs";

const ENDPOINT = "https://hallandwilcox.com.au/api/graphql/";
const SERVICE_ID = 15647; // Competition and Consumer Law
const QUERY =
  "query($limit:Int,$offset:Int,$section:[String],$orderBy:String,$rel:[EntryRelationCriteriaInput]){" +
  "entries(private:false,limit:$limit,offset:$offset,section:$section,orderBy:$orderBy,relatedToEntries:$rel){" +
  "id title url postDate @formatDateTime(format:\"j M Y\") ... on article_Entry{summary}}" +
  "entryCount(private:false,section:$section,relatedToEntries:$rel)}";
// Same fields, no service filter.
const RECENT_QUERY =
  "query($limit:Int,$section:[String],$orderBy:String){" +
  "entries(private:false,limit:$limit,section:$section,orderBy:$orderBy){" +
  "id title url postDate @formatDateTime(format:\"j M Y\") ... on article_Entry{summary}}}";

function graphql(query, variables) {
  return fetchJson(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}

async function fetchRecords() {
  const out = [];
  const seen = new Set();
  const push = (e, extra) => {
    const title = clean(e?.title);
    const url = clean(e?.url);
    if (!title || !url || seen.has(url)) return;
    seen.add(url);
    out.push({
      title,
      url,
      dateRaw: clean(e?.postDate), // "14 Apr 2026"
      teaser: clean(e?.summary),
      ...extra,
    });
  };

  // 1) The Competition and Consumer Law service — include all.
  const LIMIT = 50;
  for (let offset = 0; offset < 200; offset += LIMIT) {
    let json;
    try {
      json = await graphql(QUERY, {
        limit: LIMIT,
        offset,
        section: ["article"],
        orderBy: "postDate DESC",
        rel: [{ id: [SERVICE_ID] }],
      });
    } catch { break; }
    const entries = json?.data?.entries || [];
    if (entries.length === 0) break;
    for (const e of entries) push(e, { preFiltered: true, defaultTopics: ["Competition & Consumer"] });
    const total = Number(json?.data?.entryCount || 0);
    if (offset + LIMIT >= total) break;
  }

  // 2) Newest articles across all services — keyword filter decides.
  try {
    const json = await graphql(RECENT_QUERY, { limit: 100, section: ["article"], orderBy: "postDate DESC" });
    for (const e of json?.data?.entries || []) push(e, {});
  } catch { /* keep the service pass */ }

  return out;
}

export default {
  name: "Hall & Wilcox",
  order: 16,
  badge: { initial: "H", color: "#5c2d91" },
  sourceUrl: "https://hallandwilcox.com.au/news/?service=15647",
  domestic: true,
  fetchRecords,
};
