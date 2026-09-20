# Deploy runbook

Three things get set up, in this order. Each one works on its own, so stop after any of
them and you still have something running.

1. **Git** — publish the repo.
2. **Vercel** — serve the dashboard. GitHub Actions builds it and deploys the static
   output; Vercel's own Git integration is deliberately not used (§2.7 explains why).
3. **n8n**: label job mail in Gmail, fill the Airtable base from it, and trigger rebuilds.

Command blocks are paste-ready and run on your laptop unless noted otherwise.

---

## 1. Publish to GitHub

```bash
cd job-tracker-dashboard
git init -b main
git add .
git commit -m "Job search dashboard: build, verify, deploy, n8n ingest"
gh repo create job-tracker-dashboard --public --source=. --push
```

Public is fine and deliberate. Nothing identifying is in the repo: the build reads a
de-identified `Feed` table, `sample-feed.json` has dates and statuses but no companies, and
`scripts/verify.mjs` fails the build if a company name or email address ever shows up in
the output. That check is the reason you can leave the repo public without thinking about
it again.

Before the first push, confirm it yourself:

```bash
node scripts/verify.mjs
git ls-files | xargs grep -ril 'gmail.com\|@.*\.ph\b' || echo "clean"
```

---

## 2. Vercel

### 2.1 Create the project

```bash
# laptop, once — links nothing, just reserves the name and gives you the IDs below
npx vercel@latest projects add job-tracker-dashboard
```

Or create it from the Vercel dashboard: **Add New ▸ Project ▸ Deploy without a Git
repository** (naming it, not connecting it, is the point — see 2.7).

### 2.2 Turn off Deployment Protection

New projects default to Vercel Authentication (SSO) on production URLs without a custom
domain, which puts a login wall in front of the dashboard. This dashboard is meant to be
public, the same way the VPS version had no auth in front of it.

**Project ▸ Settings ▸ Deployment Protection ▸ Vercel Authentication ▸ Off.**

Skipping this doesn't break the deploy — it breaks the smoke test in 2.7, which expects an
anonymous `curl` to return the page, not a redirect to a login screen.

### 2.3 Get the org and project IDs

**Project ▸ Settings ▸ General** has the Project ID. The Team ID (called `VERCEL_ORG_ID`
everywhere else) is under your team's **Settings ▸ General**, or:

```bash
npx vercel@latest teams ls
```

### 2.4 Access token

**Account Settings ▸ Tokens ▸ Create Token.** Scope it to the team this project lives in,
not "Full Account" — a token scoped to one team can't touch anything else if it leaks.

### 2.5 Secrets

**Settings ▸ Secrets and variables ▸ Actions**

| Secret | Value |
|---|---|
| `AIRTABLE_API_KEY` | personal access token scoped to `data.records:read` on this base |
| `AIRTABLE_BASE_ID` | the base ID (`appXXXXXXXXXXXXXX`), from **Help ▸ API documentation** |
| `AIRTABLE_TABLE_NAME` | optional — only if the tracker table isn't named `Feed` |
| `VERCEL_TOKEN` | the token from 2.4 |
| `VERCEL_ORG_ID` | the Team ID from 2.3 |
| `VERCEL_PROJECT_ID` | the Project ID from 2.3 |
| `PUBLIC_URL` | the project's `*.vercel.app` URL, or your custom domain once you add one |

None of these belong on your laptop once they're in GitHub — that's the whole reason they're
secrets instead of a `.env` file next to the code.

### 2.6 First deploy

**Actions ▸ Build and deploy ▸ Run workflow.**

The run verifies, builds from the live feed, commits the summary, then runs
`vercel deploy dist --prod`, which uploads `dist/` as a static deployment — Vercel does no
build of its own, so it never needs the Airtable secrets. The last step curls `PUBLIC_URL`
and fails if it doesn't come back 200 with the expected markup. A green run means the page
is actually up, not that a deploy was merely accepted.

If `PUBLIC_URL` isn't set yet because you don't know the domain until after the first
deploy: run the workflow once, read the URL from **Project ▸ Deployments** or the
workflow's own log output, then add the secret and run it again.

### 2.7 Why not just connect the GitHub repo in Vercel?

Vercel's native Git integration would rebuild on every push using its own build command —
which would need the Airtable secrets duplicated into Vercel's env vars, and would produce
a second, competing deployment on top of the one this workflow already makes for the
schedule and the n8n webhook (neither of which is a git push, so Vercel's own integration
wouldn't even fire for them). One trigger path, one place secrets live: same shape as the
VPS setup this replaced, just swapping SSH+rsync for the Vercel CLI.

### 2.8 Rollback

**Project ▸ Deployments**, find the last good one, **⋯ ▸ Promote to Production**. Vercel
keeps every deployment until you delete it, so this is closer to instant than the VPS
symlink swap was.

---

## 3. n8n

### 3.1 Airtable tables

n8n writes to three tables in the same base.

**`Inbox`**: one row per classified email:

```
message_id  thread_id  received_at  company  job_title  status  max_stage  source  confidence  job_platform
```

**`Needs Review`**: one row per email the parser couldn't classify:

```
message_id  thread_id  received_at  from_address  subject  status  company  job_title  confidence
```

`message_id` should be the primary field in both. Every field can be Single line text except
`max_stage`, which is a Number. Both tables are upserted on `message_id`, so a re-poll updates
the same row instead of adding a duplicate. They are a *message* log: two emails about one job
are two rows.

**`Feed`**: the tracker. Add three fields to it:

| Field | Type | Written by |
|---|---|---|
| `Job Platform` | Single select: JobStreet, LinkedIn, Indeed, Kalibrr, OnlineJobs.ph, Torre, Company Website, Direct Email, Other | n8n, when empty |
| `Company` | Single line text | n8n, when empty |
| `Application Key` | Single line text | n8n: `company|job title` lowercased, or `platform|job title` when the board hides the employer (Indeed) |

Each classified email also upserts Feed on `Application Key`, so every application gets one
row that fills itself in. The merge (`n8n/merge-feed.js`, tested by
`scripts/test-merge-feed.mjs`) only moves a row forward:

- `Date Applied` keeps the earliest date seen.
- `Max Stage` keeps the highest stage seen.
- `Status` only advances. A late "thanks for applying" never overwrites "Interviewed".
  "Rejected" outranks every status except "Offer".
- `Job Platform`, `Company`, `Source` and `Job Role` are only filled when empty, so your edits
  win.

Rows you add by hand without an `Application Key` are left alone. `Company`, `Job Role` and
`Application Key` identify employers, and `build.mjs` never reads them: `verify.mjs` fails if
`FIELD_MAP` ever includes one.

### 3.2 Gmail labels

Create these labels (Gmail ▸ Settings ▸ Labels), then put their ids in `n8n/gmail-labels.json`:

| Label | Means |
|---|---|
| `Job Application` | in scope: yours, applied by hand or by a filter, and also applied by the workflow |
| `Job Application/Processed` | already handled; the trigger query excludes it |
| `Job Application/Applied`, `/Viewed`, `/In Review`, `/Assessment`, `/Interview`, `/Offer`, `/Rejected`, `/Talent Pool`, `/Needs Review` | the status the parser read from that email |

The ids come from the Gmail API (`users.labels.list`) or the n8n Gmail node's label dropdown.
`verify.mjs` fails if any status the parser can produce has no id.

**The trigger query** is mail under `Job Application` **or** mail containing a confirmation phrase
("thank you for applying", "received your application", "successfully submitted", "your
application was sent", "has viewed your application", …), minus `Job Application/Processed`.
The phrases are the auto-labelling: a confirmation nobody labelled is picked up, processed,
and gets `Job Application` like everything else. The full query is `JOB_MAIL_QUERY` in
`scripts/build-n8n.mjs`.

**Never leave the query without a positive scope.** Without one, the trigger polls your whole
mailbox, and every newsletter gets a full body fetch, a `Needs Review` row and a label.

**Tuning.** Noise that matches a phrase lands in `Needs Review` labelled
`Job Application/Needs Review`. If a sender keeps showing up there, narrow the phrases. If an
application shape is misclassified, add it as a parser test case first
(`scripts/test-parser.mjs`), then fix `n8n/parse-email.js`.

### 3.3 Import or deploy

n8n ▸ Workflows ▸ Import from File → `n8n/job-tracker-ingest.json`. The base, table and label
ids are already filled in. Credentials are not:

| Node | What to set |
|---|---|
| **Poll Gmail**, **Fetch Job Mail**, **Mark Email Processed** | your Gmail credential |
| **Write to Inbox**, **Write to Needs Review**, **Find Feed Row**, **Upsert Feed** | an Airtable personal access token with `data.records:read` and `data.records:write` on this base. This is a *second* token: the `AIRTABLE_API_KEY` secret in §2.6 is read-only and belongs to the dashboard build |
| **Trigger Dashboard Rebuild** | a Header Auth credential. Name: `Authorization`. Value: `Bearer github_pat_...`, a fine-grained PAT with **Contents: read and write** on this repo only |
| **Classify With LLM** | a Header Auth credential. Name: `Authorization`. Value: `Bearer <router API key>`, for the OpenAI-compatible endpoint set in `scripts/build-n8n.mjs`'s `LLM_ENDPOINT`. Only called for emails the rules in `n8n/parse-email.js` couldn't classify |

### 3.4 Backfill, test, then enable

The Gmail trigger only sees mail that arrives after the workflow is activated. To process what
is already in your mailbox, open **Backfill (manual)** and click *Execute workflow*. It runs the
trigger's query (up to 500 messages) through the same dedupe, writes and labels.

Check, in order:

1. `Inbox` has rows with sensible statuses and `job_platform` filled in.
2. `Feed` has one row per application, not one per email, with `Job Platform` set.
3. `Needs Review` has the rest.
4. Those emails carry `Job Application`, `Job Application/Processed` and a status label.
5. GitHub Actions shows a run triggered by `repository_dispatch`.

Run the backfill a second time. Nothing should change: no new rows and no new labels. If rows
duplicate, the matching field was lost on import. Reopen the Airtable nodes and confirm
*Column to match on* is `message_id`, or `Application Key` for **Upsert Feed**.

Then activate it.

### 3.5 The OAuth trap

A Google Cloud OAuth app left in **Testing** mode expires its refresh token after 7 days.
The workflow works for a week, then quietly stops. Publish the app, or use a service
account. This is the single most common way this kind of pipeline dies, and it dies
silently — n8n shows a credential error in the execution log and nowhere else.

Worth doing: n8n ▸ Settings ▸ **Log Streaming** or an error workflow that emails you on
failure. Otherwise the first sign is a dashboard that stopped changing.

---

## Changing the parser

The classifier lives in `n8n/parse-email.js` and has tests. Do not edit it in the n8n UI —
your change gets overwritten the next time anyone regenerates the workflow, and CI will
fail in the meantime.

```bash
$EDITOR n8n/parse-email.js
node scripts/test-parser.mjs      # add a case for whatever email fooled it
node scripts/build-n8n.mjs        # regenerate the workflow
node scripts/verify.mjs
git commit -am "parser: handle <the email shape>"
```

Then re-import the JSON into n8n. When an email lands in `needs-review` that shouldn't
have, paste its subject into `scripts/test-parser.mjs` as a new case first — that way the
same email can never fool it twice.

---

## When something breaks

| Symptom | Cause |
|---|---|
| Smoke test gets a redirect/login page instead of 200 | Deployment Protection still on — turn it off (2.2) |
| `vercel deploy` fails with "Project not found" | `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` wrong or from a different team than the token (2.3–2.4) |
| Deploy succeeds, `PUBLIC_URL` still 404s | secret set to a guessed domain before the first deploy told you the real one (2.6) |
| Two deployments appear for one push | the GitHub repo got connected in Vercel's own Git integration — disconnect it (2.7) |
| Rows duplicating in `Inbox` or `Feed` | matching field lost on import (3.4) |
| Same emails reprocessed every poll | `Job Application/Processed` not applied, or not excluded in the query |
| `Needs Review` full of newsletters | trigger phrases too broad — narrow `JOB_MAIL_QUERY` (3.2) |
| `401`/`403` from Airtable | personal access token missing the right scope, or scoped to the wrong base |
| Applications not showing up at all | not under `Job Application` and no trigger phrase matches, or the backfill was never run (3.4) |
| Workflow stopped after ~a week | OAuth app still in Testing mode (3.5) |
| Scheduled builds stopped after ~2 months | GitHub disables cron after 60 days of repo inactivity; the `summary.json` commit exists to prevent this |
| Charts blank, numbers fine | ApexCharts didn't load from cdnjs; the Sankey still renders because it's server-side SVG |
