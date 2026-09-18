# Job search dashboard — self-updating build

Turns the Google Sheet job-application tracker into an analytics dashboard that rebuilds itself
on a schedule and deploys to a VPS. Aggregate figures only: no company names, job titles,
contacts, links, notes or salary ever leave the Sheet.

**Setting it up? Go to [DEPLOY.md](DEPLOY.md).** This file explains what the thing is and how it
works; DEPLOY.md is the runbook.

**Stack:** [TailAdmin](https://tailadmin.com/) design tokens on the Tailwind play CDN, seven
[ApexCharts](https://apexcharts.com/) charts, and one hand-drawn inline-SVG Sankey (ApexCharts has
no Sankey type). No build step, no `npm install`, no framework.

**Charts, all derived from the nine feed columns and nothing else:** stage-flow Sankey · funnel ·
status mix donut · channel reply rates (stacked) · applications per month · ageing of open
applications · work-setup split · application quality. Eight stat tiles above them.

Satoshi, TailAdmin's typeface, is not on Google Fonts, so Plus Jakarta Sans stands in for it.

```
Gmail ──▶ n8n ──▶ inbox tab ──▶ you ──▶ data tab ──▶ Actions ──▶ VPS
          │       needs-review          (the tracker)   │        (nginx/Caddy,
          │                                             │         atomic releases)
          └── repository_dispatch ──────────────────────▶┘
                                            │
                                            └──▶ data/summary.json committed each run
                                                 (git history = the time series)
```

n8n classifies each email and writes it to `inbox` or `needs-review`, keyed on the Gmail message
id so a re-poll updates the same row instead of duplicating it. It never writes to `data` — an
email is about a *message*, not an *application*, and two emails about one job are two messages.
You still own the tracker; the automation just stops you from missing anything.

---

## Why GitHub Actions and n8n, not one or the other

They are not alternatives. n8n is good at the Gmail hop — OAuth, retries and dedupe are solved
there. It has no answer for building and shipping a website. Actions is the reverse. Split by
layer and each tool does what it is good at, and the seam between them is one
`repository_dispatch` call.

The full reasoning, including failure modes and the later stages, is in the project doc
`claude/tracker-pipeline-architecture.md`.

---

## Setup — about 10 minutes

### 1. Rename the data tab to `data`

Open the tracker Sheet. The tab created by the CSV import has a long name; double-click it and
rename it to exactly `data`. The formula in the next step references it by name.

### 2. Add a `feed` tab

This is the privacy boundary. The `feed` tab holds only the columns the dashboard needs, so the
published CSV cannot leak anything even if its URL escapes.

Create a new tab named `feed`. Put these nine headers in `A1:I1`:

```
date_applied   source   work_setup   status   resume   cover_letter   tailored   next_follow_up   max_stage
```

Then paste this single formula into `A2`:

```
=IFERROR(FILTER(
  {ARRAYFORMULA(IF(data!B33:B500="","",TEXT(data!B33:B500,"yyyy-mm-dd"))),
   data!E33:E500, data!F33:F500, data!G33:G500,
   data!H33:H500, data!I33:I500, data!J33:J500,
   ARRAYFORMULA(IF(data!N33:N500="","",TEXT(data!N33:N500,"yyyy-mm-dd"))),
   data!T33:T500},
  data!C33:C500<>""), "")
```

The `TEXT(..., "yyyy-mm-dd")` wrappers are not decoration. A published CSV renders dates in the
Sheet's locale, so `17/09/2026` or `9/17/2026` depending on settings — and the build parses
`YYYY-MM` to group by month. Forcing ISO here kills a silent bug that would only show up as a
mysteriously empty "applications per month" chart.

### 3. Publish only the `feed` tab

**File ▸ Share ▸ Publish to web** → pick **feed** (not "Entire document") → **Comma-separated
values (.csv)** → Publish. Copy the URL.

Double-check the dropdown says `feed`. Publishing the entire document publishes your row-level
data.

### 4. Add the URL as a repo secret

**Settings ▸ Secrets and variables ▸ Actions ▸ New repository secret**

- Name: `FEED_CSV_URL`
- Value: the URL from step 3

It goes in a secret rather than the source not because the contents are sensitive — the feed tab
is de-identified — but so the URL isn't trivially scrapeable and can be rotated.

### 5. Set up the VPS and the rest of the secrets

[DEPLOY.md](DEPLOY.md) §2 — release layout, `activate.sh`, the deploy key, the web server
config. Then **Actions ▸ Build and deploy ▸ Run workflow**. The run ends by curling your public
URL and fails if the page isn't actually up.

---

## Optional: sharpen the funnel with `max_stage`

A rejection tells you an application ended, not how far it got. With no extra information the
build has to credit every rejection to the application stage, which understates the funnel.

Put a number 1–5 in column **T** of the `data` tab for any row where the rejection hid a deeper
stage. Everything else can stay blank — the build falls back to inferring the stage from Status.

| Stage | Meaning |
|---|---|
| 1 | never got past applying |
| 2 | employer replied, viewed, pooled or reviewed |
| 3 | reached an assessment or take-home |
| 4 | reached an interview |
| 5 | received an offer |

From the current dataset, four rows need this — the rest are correct by inference:

| Row | Company | `max_stage` | Why |
|---|---|---|---|
| 5 | PriceLabs | `4` | two assignments and an interview before the decline |
| 15 | Yngen Datacom | `2` | viewed 4 Aug, then declined |
| 63 | BruntWork (AI-Assisted Software) | `4` | interviewed, declined 15 Sep |
| 72 | City People Solutions | `2` | viewed 3 Sep, declined 4 Sep |

With those four filled in, the funnel reads `97 → 31 → 12 → 3 → 0`. Without them it reads
`97 → 27 → 10 → 1 → 0` and the page says so rather than pretending otherwise.

---

## Local development

```bash
# build against the checked-in fixture — no network, no secret
FEED_CSV_URL=./sample-feed.csv node scripts/build.mjs
open dist/index.html

# build against the real feed
FEED_CSV_URL='https://docs.google.com/.../pub?output=csv' node scripts/build.mjs
```

`sample-feed.csv` is a de-identified snapshot of the real 97 rows — dates, sources and statuses
only. It exists so the build is testable without touching the Sheet, and so a change to the
aggregation logic can be diffed against known-good output.

No `npm install`. Node 20+ only, zero dependencies.

---

## How it fits together

| File | Does what |
|---|---|
| `scripts/build.mjs` | fetch → parse CSV → aggregate → lay out the Sankey → fill the template |
| `templates/dashboard.html` | TailAdmin markup, Tailwind config, chart code; three `{{PLACEHOLDER}}` slots |
| `.github/workflows/deploy.yml` | verify, build, commit the summary, rsync to the VPS, activate, smoke-test |
| `scripts/verify.mjs` | 31 pre-deploy checks: funnel arithmetic, the privacy boundary, n8n invariants |
| `scripts/build-n8n.mjs` | generates the importable n8n workflow from the tested parser |
| `scripts/test-parser.mjs` | runs the email classifier against real email shapes, outside n8n |
| `n8n/parse-email.js` | the classifier — **edit this, never the JSON** |
| `n8n/job-tracker-ingest.json` | generated; import into n8n |
| `deploy/activate.sh`, `deploy/rollback.sh` | release swap and rollback on the VPS |
| `data/summary.json` | aggregate counts, rewritten and committed every run |
| `dist/index.html` | standalone page for Pages (git-ignored) |
| `dist/artifact.html` | same body without the `<html>` skeleton, for publishing as a Claude artifact |

The build emits one `window.__DATA__`-style JSON payload and the chart code reads it, so adding a
chart means adding a field in `aggregate()` and a `mount()` call — not another placeholder.

The build fails loudly rather than shipping a broken page: a template placeholder left unfilled,
a feed that parses to zero rows, or a feed missing its `status` column all exit non-zero.

---

## Troubleshooting

**"Feed returned HTML, not CSV"** — the tab was unpublished, or the URL points at the document
rather than the CSV export. Re-do step 3. Google returns a `200` with an HTML error page here,
which is why the build checks the body instead of trusting the status code.

**"Feed parsed to zero rows"** — the `feed` formula is referencing the wrong tab name, or the
data tab isn't called `data`. Check step 1.

**Month chart is empty but everything else works** — dates are coming through in a non-ISO
locale format. The `TEXT()` wrappers in step 2 are missing.

**Scheduled runs stopped after a couple of months** — GitHub disables cron on repos with 60 days
of no activity. The `data/summary.json` commit exists partly to prevent this; if you removed that
step, this is why.

**Charts are blank but the tiles show numbers.** ApexCharts did not load from cdnjs. The Sankey is
server-rendered SVG so it survives that; everything else needs the script.

**Everything is unstyled.** The Tailwind play CDN did not load. It compiles classes in the browser,
so there is no local CSS fallback by design.

**The schedule runs late.** Expected. Actions cron is best-effort and queues behind everything
else on the platform. The workflow uses minute 17 rather than 0 to sit outside the busiest slot,
but treat it as "a few times a day", never "on the hour".

---

## Deliberately not built yet

| Stage | What | Why it's later |
|---|---|---|
| 4 | Row-per-application in `inbox` | needs company/title matching, which is fuzzy. Keying on `message_id` is provably correct; matching applications is a guess, and a guess that writes to your tracker is worse than a log you skim. |
| 5 | Commit row-level history | needs the privacy decision revisited; aggregates already give a time series |
| 6 | Time-in-stage analytics, true time-based Sankey | needs ~4 weeks of committed history before the numbers mean anything |

Today's Sankey reconstructs each application's path from its current status and `max_stage`. Once
there are weeks of committed summaries, `git log` becomes the actual transition table and the
diagram can show real elapsed time between stages instead of inferred depth.

The parser fills `max_stage` automatically, which the README used to ask you to do by hand: a
rejection that mentions the interview it followed gets credited to stage 4, not stage 1. That is
the difference between a funnel that reads `97 → 31 → 12 → 3` and one that reads `97 → 27 → 10 → 1`
and understates every conversion rate in the dashboard.
