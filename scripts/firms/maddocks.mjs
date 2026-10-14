// scripts/firms/maddocks.mjs
//
// Maddocks — Australian (Craft CMS behind a Cloudflare challenge that trips a
// plain Node fetch on TLS fingerprint). We use headless Chromium: load the
// insights page (passes Cloudflare, sets cookies), then do the CSRF + listing
// partial POST IN-PAGE and parse the tiles. Filtered to the firm's "Competition,
// Antitrust & Regulation" capability → include all (over-include).
// Card: article.c-insight-tile → h1 a (title/url), .uk-card-body
// span.uk-text-teal-medium (date DD/MM/YYYY), p.uk-text-emphasis (teaser).
// The old layout's span.uk-text-muted / p.uk-text-muted-dark are kept as
// fallbacks. Not a bare .uk-text-teal-medium: the footer's author line uses it.

import { withPage } from "../lib/browser.mjs";
import { clean, parseDateToISO } from "../lib/shared.mjs";

const ORIGIN = "https://www.maddocks.com.au";
const CAPABILITY = "competition-antitrust-regulation";

async function fetchRecords() {
  const raw = await withPage(`${ORIGIN}/insights`, async (page) => {
    return page.evaluate(async (capability) => {
      function txt(el) { return el ? el.textContent.replace(/\s+/g, " ").trim() : ""; }
      // CSRF token
      const csrf = await (await fetch("/dynamic/csrf", { headers: { Accept: "application/json" } })).json();
      const token = csrf && csrf.csrf && csrf.csrf.value;
      const out = [];
      const seen = new Set();
      for (let pageNo = 1; pageNo <= 8; pageNo++) {
        const body = new URLSearchParams();
        body.append("q", "");
        body.append("capabilities[]", capability);
        body.append("type", "");
        body.append("sort", "date-new");
        body.append("page", String(pageNo));
        body.append("CRAFT_CSRF_TOKEN", token);
        const res = await fetch("/partials/insight-search", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body: body.toString(),
        });
        const html = await res.text();
        if (/No results found/i.test(html)) break;
        const doc = new DOMParser().parseFromString(html, "text/html");
        const tiles = doc.querySelectorAll("article.c-insight-tile");
        if (!tiles.length) break;
        let added = 0;
        tiles.forEach((t) => {
          const a = t.querySelector("h1 a");
          if (!a) return;
          const href = a.getAttribute("href") || "";
          const url = href.startsWith("http") ? href : "https://www.maddocks.com.au" + href;
          if (seen.has(url)) return;
          seen.add(url);
          added++;
          out.push({
            title: txt(a),
            url,
            date: txt(t.querySelector(".uk-card-body span.uk-text-teal-medium")) ||
              txt(t.querySelector("span.uk-text-muted")),
            teaser: txt(t.querySelector("p.uk-text-emphasis")) ||
              txt(t.querySelector("p.uk-text-muted-dark")),
          });
        });
        if (!added) break;
      }
      return out;
    }, CAPABILITY);
  }, { waitMs: 6000 });

  return (raw || []).map((r) => ({
    title: clean(r.title),
    url: r.url,
    dateISO: parseDateToISO(r.date),
    teaser: clean(r.teaser),
    preFiltered: true,
    defaultTopics: ["Competition & Consumer"],
  }));
}

export default {
  name: "Maddocks",
  order: 14,
  badge: { initial: "M", color: "#00843d" },
  sourceUrl: "https://www.maddocks.com.au/insights",
  domestic: true,
  fetchRecords,
};
