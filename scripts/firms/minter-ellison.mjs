// scripts/firms/minter-ellison.mjs
//
// MinterEllison — Australian (Sitecore + Solr). The "Competition, Consumer &
// Regulation" practice feed is a JSON API gated by a short-lived JWT that is
// minted into the practice landing page. So we: (1) GET the practice page and
// scrape data1 (JWT) + data2 (page URL) from hidden divs, then (2) GET the
// dynamicsearch API filtered to that practice facet and include all.
// Fields: Results[].Title / AbsoluteUrl / ArticleDate ("DD.MM.YYYY") / Summary.

import { fetchText, fetchJson, clean } from "../lib/shared.mjs";
import { withPage } from "../lib/browser.mjs";

const ORIGIN = "https://www.minterellison.com";
const PRACTICE_URL = `${ORIGIN}/competition-consumer-and-regulation`;
const API = `${ORIGIN}/api/dynamicsearch/`;
const GRID = {
  itemid: "9cb7a0bc-eeaf-4641-8d2f-e282212e8e07",
  s: "afe1b5ed-28dc-47fd-945b-acffb8912e81",
  f: "c70278f7-7f2a-48a0-9327-8cb5da4582c2=[6b26bc80e6e348e0861d981b1f2963c8]",
  searchglobal: "{06625DFD-1B81-49A1-A9BC-63EA05E1EAB8}",
};

function isoFromDots(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(clean(s));
  if (!m) return null;
  if (m[3] === "0001") return null; // undated legacy items
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** The fresh JWT (data1) + page URL (data2) minted into the practice page. */
function readJwt(html) {
  const d1 = /<div[^>]*id="dynamicdata1"[^>]*>([^<]+)<\/div>/i.exec(html);
  const d2 = /<div[^>]*id="dynamicdata2"[^>]*>([^<]+)<\/div>/i.exec(html);
  if (!d1) throw new Error("MinterEllison: could not read data1 JWT");
  return { data1: clean(d1[1]), data2: clean(d2 ? d2[1] : PRACTICE_URL) };
}

/** The practice-filtered feed (l=1000 returns the whole set). */
function apiUrl({ data1, data2 }) {
  const params = new URLSearchParams({
    itemid: GRID.itemid, s: GRID.s, f: GRID.f, searchglobal: GRID.searchglobal,
    q: "", o: "", x: "", searchtype: "", l: "1000", start: "0",
    data1, data2,
  });
  return `${API}?${params.toString()}`;
}

/** The same two requests, made from inside the workflow's headless browser. */
function viaBrowser() {
  return withPage(PRACTICE_URL, async (page) => {
    const url = apiUrl(readJwt(await page.content()));
    return page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }, url);
  });
}

async function fetchRecords() {
  // GitHub's servers get HTTP 403 from minterellison.com (Oct 2026, by IP: a
  // normal connection still gets through), so a refused plain request falls
  // back to the headless browser. The refusal is reported (lastError).
  const errors = [];
  let json;
  try {
    const html = await fetchText(PRACTICE_URL);
    json = await fetchJson(apiUrl(readJwt(html)), {
      headers: { "X-Requested-With": "XMLHttpRequest", Referer: PRACTICE_URL },
    });
  } catch (err) {
    errors.push(`plain request: ${String(err.message).split(" for ")[0]}; used the headless browser`);
    json = await viaBrowser();
  }
  const results = Array.isArray(json?.Results) ? json.Results : [];
  const out = [];
  const seen = new Set();
  for (const r of results) {
    const title = clean(r?.Title);
    const url = clean(r?.AbsoluteUrl || r?.RelativeUrl);
    if (!title || !url) continue;
    const full = url.startsWith("http") ? url : ORIGIN + url;
    if (seen.has(full)) continue;
    seen.add(full);
    out.push({
      title,
      url: full,
      dateISO: isoFromDots(r?.ArticleDate),
      teaser: clean(r?.Summary),
      preFiltered: true,
      defaultTopics: ["Competition & Consumer"],
    });
  }
  out.errors = errors;
  return out;
}

export default {
  name: "MinterEllison",
  order: 5,
  badge: { initial: "M", color: "#e00034" },
  sourceUrl: "https://www.minterellison.com/competition-consumer-and-regulation",
  domestic: true,
  fetchRecords,
};
