# Job search dashboard — self-updating build

Turns an Airtable job-application tracker into an analytics dashboard that rebuilds itself
on a schedule and deploys to a VPS. Aggregate figures only: no company names, job titles,
contacts, links, notes or salary ever leave the base.

**Setting it up? Go to [DEPLOY.md](DEPLOY.md).** This file explains what the thing is and how it
works; DEPLOY.md is the runbook.

**Database: [Airtable](https://airtable.com/).** The tracker itself — the `Feed` table — and
n8n's message-level ingest log (`Inbox`, `Needs Review`) all live in one Airtable base.
`scripts/build.mjs` reads `Feed` straight from Airtable's REST API
(`api.airtable.com/v0/{baseId}/{tableName}`); nothing in this project reads from a spreadsheet
CSV export.

**Stack:** Airtable for storage, [TailAdmin](https://tailadmin.com/) design tokens on the
Tailwind play CDN, seven [ApexCharts](https://apexcharts.com/) charts, and one hand-drawn
inline-SVG Sankey (ApexCharts has no Sankey type). No build step, no `npm install`, no framework.

**Charts, all derived from the nine `Feed` table fields and nothing else:** stage-flow Sankey · funnel ·
status mix donut · channel reply rates (stacked) · applications per month · ageing of open
applications · work-setup split · application quality. Eight stat tiles above them.

Satoshi, TailAdmin's typeface, is not on Google Fonts, so Plus Jakarta Sans stands in for it.

```
Gmail ──▶ n8n ──▶ Inbox table ──▶ you ──▶ Feed table ──▶ Actions ──▶ VPS
          │       Needs Review           (the tracker)   │        (nginx/Caddy,
          │                                              │         atomic releases)
          └── repository_dispatch ───────────────────────▶┘
                                             │
                                             └──▶ data/summary.json committed each run
                                                  (git history = the time series)
```

n8n classifies each email and writes it to the `Inbox` or `Needs Review` table (an upsert keyed
on the Gmail message id, so a re-poll updates the same row instead of duplicating it). It never
writes to `Feed` — an email is about a *message*, not an *application*, and two emails about one
job are two messages. You still own the tracker; the automation just stops you from missing
anything.

**Everything lives in one Airtable base** — `Feed` (the tracker you maintain and the table
`scripts/build.mjs` reads), plus `Inbox` and `Needs Review` (n8n's message-level ingest log,
separate tables so an automated write can never silently overwrite something you typed). Airtable
also fixes a real Google Sheets pain point this project used to have: date fields come back as
plain ISO-8601 strings from the API regardless of anyone's locale settings, so there's no more
`TEXT(..., "yyyy-mm-dd")` formula workaround to get right.

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

### 1. Create the Airtable base

Create a base named something like "Job Tracker". Inside it, create a table named exactly
**`Feed`** — this is both your tracker and the privacy boundary: it holds only the columns the
dashboard needs, so a leaked API key scoped to this table alone can't expose company names,
contacts or notes, because they were never in it.

Give `Feed` these nine fields, with these exact names and types:

| Field | Type |
|---|---|
| `Date Applied` | Date (ISO 8601 / "Friendly" doesn't matter — the API always returns ISO) |
| `Source` | Single line text |
| `Work Setup` | Single line text |
| `Status` | Single select or single line text |
| `Resume` | Checkbox |
| `Cover Letter` | Checkbox |
| `Tailored` | Checkbox |
| `Next Follow Up` | Date |
| `Max Stage` | Number |

This is the table you fill in by hand as you apply — same data you'd have put in a spreadsheet
row, just in Airtable.

### 2. Create a personal access token

Airtable ▸ your account ▸ **Developer hub ▸ Personal access tokens ▸ Create token**.

- Scopes: `data.records:read`
- Access: this one base only

Copy the token (`pat...`) — Airtable only shows it once.

### 3. Add the secrets

**Settings ▸ Secrets and variables ▸ Actions ▸ New repository secret**

| Secret | Value |
|---|---|
| `AIRTABLE_API_KEY` | the personal access token from step 2 |
| `AIRTABLE_BASE_ID` | the base ID from the base's API docs (**Help ▸ API documentation**), looks like `appXXXXXXXXXXXXXX` |

`AIRTABLE_TABLE_NAME` is optional and defaults to `Feed` — only set it if you named the table
something else.

### 4. Set up the VPS and the rest of the secrets

[DEPLOY.md](DEPLOY.md) §2 — release layout, `activate.sh`, the deploy key, the web server
config. Then **Actions ▸ Build and deploy ▸ Run workflow**. The run ends by curling your public
URL and fails if the page isn't actually up.

### 5. n8n and the ingest tables

[DEPLOY.md](DEPLOY.md) §3 covers the two extra Airtable tables (`Inbox`, `Needs Review`) that
n8n writes to, and importing `n8n/job-tracker-ingest.json`.

> **Coming from the old Google Sheets version of this project?** The Sheets-specific setup
> (publish-to-web CSV, `feed` formula, `FEED_CSV_URL`) no longer applies — it's superseded by the
> Airtable steps above. See the git history before this migration if you need the old steps for
> reference.

---

## Optional: sharpen the funnel with `max_stage`

A rejection tells you an application ended, not how far it got. With no extra information the
build has to credit every rejection to the application stage, which understates the funnel.

Put a number 1–5 in the `Max Stage` field of the `Feed` table for any row where the rejection hid
a deeper stage. Everything else can stay blank — the build falls back to inferring the stage from
Status.

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
FEED_FIXTURE=./sample-feed.json node scripts/build.mjs
open dist/index.html

# build against the real base
AIRTABLE_API_KEY=pat... AIRTABLE_BASE_ID=app... node scripts/build.mjs
```

`sample-feed.json` is a de-identified snapshot of the real 97 rows — dates, sources and statuses
only, shaped exactly like Airtable's list-records API response (`{ "records": [{ "id", "fields":
{...} }] }`). It exists so the build is testable without touching the base, and so a change to
the aggregation logic can be diffed against known-good output.

No `npm install`. Node 20+ only, zero dependencies.

---

## How it fits together

| File | Does what |
|---|---|
| `scripts/build.mjs` | fetch from Airtable → aggregate → lay out the Sankey → fill the template |
| `templates/dashboard.html` | TailAdmin markup, Tailwind config, chart code; three `{{PLACEHOLDER}}` slots |
| `.github/workflows/deploy.yml` | verify, build, commit the summary, rsync to the VPS, activate, smoke-test |
| `scripts/verify.mjs` | 32+ pre-deploy checks: funnel arithmetic, the privacy boundary, n8n invariants |
| `scripts/build-n8n.mjs` | generates the importable n8n workflow from the tested parser |
| `scripts/test-parser.mjs` | runs the email classifier against real email shapes, outside n8n |
| `n8n/parse-email.js` | the classifier — **edit this, never the JSON** |
| `n8n/job-tracker-ingest.json` | generated; import into n8n |
| `deploy/activate.sh`, `deploy/rollback.sh` | release swap and rollback on the VPS |
| `data/summary.json` | aggregate counts, rewritten and committed every run |
| `sample-feed.json` | de-identified fixture, Airtable list-records shape, for local dev and CI |
| `dist/index.html` | standalone page for Pages (git-ignored) |
| `dist/artifact.html` | same body without the `<html>` skeleton, for publishing as a Claude artifact |

The build emits one `window.__DATA__`-style JSON payload and the chart code reads it, so adding a
chart means adding a field in `aggregate()` and a `mount()` call — not another placeholder.

The build fails loudly rather than shipping a broken page: a template placeholder left unfilled,
a feed that parses to zero rows, or a feed missing its `status` column all exit non-zero.

---

## Troubleshooting

**"AIRTABLE_API_KEY / AIRTABLE_BASE_ID are not set"** — set both secrets (step 3), or run locally
against the fixture with `FEED_FIXTURE=./sample-feed.json`.

**"Airtable fetch failed: 401/403"** — the personal access token doesn't have `data.records:read`
on this base, or was scoped to the wrong base. Recreate it (step 2).

**"Feed table returned zero records"** — `AIRTABLE_BASE_ID` or `AIRTABLE_TABLE_NAME` points at
the wrong base/table, or the `Feed` table really is empty.

**"Feed table has no 'Status' field"** — a field was renamed or deleted in Airtable. Field names
in the `Feed` table must match step 1 exactly (case-sensitive).

**Month chart is empty but everything else works** — `Date Applied` isn't a Date field in
Airtable (it's Single line text with a non-ISO value), so `date_applied` doesn't match
`YYYY-MM-DD`. Fix the field type in step 1.

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
| 4 | Row-per-application in `Inbox` | needs company/title matching, which is fuzzy. Keying on `message_id` is provably correct; matching applications is a guess, and a guess that writes to your tracker is worse than a log you skim. |
| 5 | Commit row-level history | needs the privacy decision revisited; aggregates already give a time series |
| 6 | Time-in-stage analytics, true time-based Sankey | needs ~4 weeks of committed history before the numbers mean anything |

Today's Sankey reconstructs each application's path from its current status and `max_stage`. Once
there are weeks of committed summaries, `git log` becomes the actual transition table and the
diagram can show real elapsed time between stages instead of inferred depth.

The parser fills `max_stage` automatically, which the README used to ask you to do by hand: a
rejection that mentions the interview it followed gets credited to stage 4, not stage 1. That is
the difference between a funnel that reads `97 → 31 → 12 → 3` and one that reads `97 → 27 → 10 → 1`
and understates every conversion rate in the dashboard.
