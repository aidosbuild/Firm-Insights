# Australian Firm Insights — competition & consumer law digest

A self-updating static website that aggregates the **insights / media releases of
17 Australian law firms**, filtered to **Australian / NSW-Sydney content that touches
competition and/or consumer law**. One sortable, searchable table per firm, with
a code-generated monogram badge next to each heading. It refreshes automatically
**three times a day** via a GitHub Action and deploys on **GitHub Pages** — no server,
no build step, the front end just reads a committed `data.json`.

Scope: only articles dated **1 January 2026 onwards** are shown (configurable via
the `START_DATE` env var in `scripts/scrape.mjs`).

Live site: <https://aidosbuild.github.io/firm-insights/>

---

## The 17 firms

Shown in this order (Addisons first). "Method" is how each firm's competition /
consumer list is fetched — wherever possible, from the firm's **own** practice /
topic classification so EVERY article the firm files under competition/consumer
is included (not just keyword matches).

| # | Firm | Method |
|---|------|--------|
| 1 | Addisons | WordPress REST (`td_insights`) ∪ its "Competition, Consumer & Antitrust" capability tag |
| 2 | Allens | Server-rendered search filtered to its "Competition, Consumer & Regulatory" practice (`t=262`) |
| 3 | Mallesons | Headless Chromium (passes Cloudflare) → its "Competition & Antitrust" practice page + per-article JSON-LD dates |
| 4 | Gilbert + Tobin | Headless Chromium → Funnelback JSON; per-article "service" tag = competition ∪ keywords |
| 5 | MinterEllison | JWT-gated Solr API for its "Competition, Consumer & Regulation" practice |
| 6 | Clayton Utz | Azure Cognitive Search JSON — competition/consumer expertise tags |
| 7 | Ashurst | Sitecore SXA JSON — Australia × Antitrust/Competition + Products/Consumer practices |
| 8 | Baker McKenzie | Sitecore insights API — Australia × Antitrust & Consumer practices + AU keyword queries |
| 9 | Bird & Bird | Solr JSON — Australia × competition/consumer/merger practice facets |
| 10 | Herbert Smith Freehills Kramer | **Manual** (hard Cloudflare block that headless can't pass) |
| 11 | Gadens | Theme AJAX → its "Competition, Consumer and Trade Law" practice + per-article JSON-LD dates |
| 12 | Corrs Chambers Westgarth | Elastic App Search — Competition capabilities + recent insights + SSR homepage |
| 13 | Dentons | ASMX (base64+gzip) — **Sydney** × Competition practice + Sydney keyword pass |
| 14 | Maddocks | Headless Chromium (passes Cloudflare) → Craft listing partial for its Competition/Antitrust capability |
| 15 | Hall & Wilcox | Craft GraphQL — its "Competition and Consumer Law" service |
| 16 | Macpherson Kelley | WordPress REST — its "competition and consumer" expertise taxonomy |
| 17 | Mills Oakley | WordPress REST — its "Competition, Regulatory and Risk" practice + keyword pass |

Every firm except **HSF Kramer** updates itself three times a day. HSF Kramer sits
behind a Cloudflare challenge headless browsers can't pass, so its table is
filled from `manual-entries.json` — see *Adding entries by hand* below. Firms
marked "Headless Chromium" need the Playwright browser (installed in CI).
(Norton Rose Fulbright and DLA Piper were dropped — neither has findable
Australian competition/consumer content dated in the current window.)

## How the selection works

- **Over-include by the firm's own classification.** When a firm's site files an
  article under a "Competition / Consumer / Trade" practice, topic or capability,
  EVERY such article is included (`preFiltered`) — even if its text never trips
  our keywords. This is the authoritative signal.
- **Keyword engine (the safety net).** Anything not practice-tagged still passes
  through a competition/consumer keyword engine (`scripts/lib/shared.mjs`):
  unambiguous signals (ACCC, cartel, merger control, Australian Consumer Law,
  misleading conduct, unfair contract terms, greenwashing, product safety, …)
  qualify an article and set its Topic; generic words ("penalties",
  "enforcement", "pricing") only add a label to an already-relevant article. The
  bias is **lean-to-include**.
- **Jurisdiction.** International firms (Ashurst, Baker, Bird & Bird, HSF) are
  queried Australia-only; domestic firms are kept unless a piece is plainly about
  another country with no Australian tie (they run Asia/UK/US practices too).
- **Date window.** Only articles dated **1 January 2026 onward** are shown.

## Architecture

```
index.html                  ← front end (reads data.json), no build step
assets/css/styles.css        ← styling (orange / white / dark-gray, blue links)
assets/js/app.js             ← tables, filters, sort, search, zoom
assets/logos/                ← optional real logo files (see Badges)
data.json                    ← committed output of the scraper
manual-entries.json          ← hand-added articles (deep-merged in)
scripts/scrape.mjs           ← the shared runner
scripts/lib/shared.mjs       ← fetch, dates, relevance + jurisdiction filters
scripts/lib/browser.mjs      ← headless-Chromium helper (Cloudflare firms)
scripts/firms/<firm>.mjs     ← one adapter per firm
.github/workflows/update.yml ← twice-daily cron + manual "Run workflow"
```

Each adapter exports `{ name, order, badge, sourceUrl, domestic, fetchRecords }`.
The runner iterates them, applies the shared filters + the date window, dedupes
by URL, merges the manual layer, and writes `data.json` shaped as
`{ generatedAt, firms: [{ name, badge, records: [...] }] }`.

### Robustness

- A firm that **errors** keeps its previous records rather than blanking — one
  broken firm never empties the site.
- So that a kept list can't go stale unnoticed, each firm in `data.json` has
  `lastOkAt` (when it last returned articles), `keptPrevious` and `lastError`.
  The workflow's last step (`scripts/check-stale.mjs`, after the commit) fails
  the run, and GitHub emails, when a scraped firm hasn't returned articles for
  over 7 days.
- `data.json` is only rewritten when the data actually changed.
- The front end shows an amber staleness banner if the data is > 24h old.

## Adding entries by hand (`manual-entries.json`)

For the manual firms (or to pin anything the scraper misses), add an entry under
the exact firm name:

```json
{
  "Mallesons": [
    {
      "title": "ACCC's new merger regime: what dealmakers need to know",
      "url": "https://www.mallesons.com/au/en/insights/latest-thinking/....html",
      "date": "10 July 2026",
      "topic": "Mergers, ACCC",
      "teaser": "Optional one-line description."
    }
  ]
}
```

`date` accepts "10 July 2026", "2026-07-10", etc. Manual entries are deduped by
URL (manual wins), tagged `manual` on the site, and are **not** date-filtered.

## Badges / logos

Each firm shows a code-generated monogram tile (initial + brand colour) by
default. To use a real logo, drop a file at `assets/logos/<firm>.svg|png` and set
`badge: { logo: "assets/logos/<firm>.svg" }` in that adapter. Firm logos are
trademarks — only use files you're entitled to; never hotlink.

## Local development

```bash
npm install
npx playwright install chromium   # only needed for the Gilbert + Tobin adapter
npm run scrape                     # rebuild data.json
python3 -m http.server 8765        # then open http://localhost:8765
```

Change the date window: `START_DATE=2025-01-01 npm run scrape`.

## Deployment

GitHub Pages from `main` / root. The Action (`.github/workflows/update.yml`) runs
at ~07:00, ~15:00 and ~23:00 Sydney (and on demand), rebuilds `data.json`, and commits it
only when it changed.
