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
| `PUBLIC_URL` | optional — no longer read by the workflow (see 2.6); a bookmark for your own custom domain if you set one |
| `N8N_API_URL` | your n8n base URL, e.g. `https://n8n.example.com`. Used only by `health.yml` (§3.8) |
| `N8N_API_KEY` | an n8n API key (n8n ▸ Settings ▸ n8n API). Used only by `health.yml` (§3.8) |

None of these belong on your laptop once they're in GitHub — that's the whole reason they're
secrets instead of a `.env` file next to the code.

### 2.6 First deploy

**Actions ▸ Build and deploy ▸ Run workflow.**

The run verifies, builds from the live feed, commits the summary, then runs
`vercel deploy dist --prod`, which uploads `dist/` as a static deployment — Vercel does no
build of its own, so it never needs the Airtable secrets. The deploy step captures the URL
`vercel deploy` prints and hands it to the smoke test, which curls that URL and fails if it
doesn't come back 200 with the expected markup. A green run means the page is actually up,
not that a deploy was merely accepted — and because the smoke test checks the URL this run
just deployed rather than a hand-set secret, there's nothing to keep in sync after the first
deploy.

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
| `Application Key` | Single line text | n8n: `company|job title` lowercased. Keys you type by hand match regardless of case or spaces around `|` |

Each classified email also upserts Feed on `Application Key`, so every application gets one
row that fills itself in. The merge (`n8n/merge-feed.js`, tested by
`scripts/test-merge-feed.mjs`) only moves a row forward:

- `Date Applied` keeps the earliest date seen.
- `Max Stage` keeps the highest stage seen.
- `Status` only advances. A late "thanks for applying" never overwrites "Interviewed".
  "Rejected" outranks every status except "Offer".
- `Job Platform`, `Company`, `Source` and `Job Role` are only filled when empty, so your edits
  win.

An email whose employer can't be read (Indeed confirmations never name one) is **not** written
to Feed. It stops at Needs Review, because without a company there is no key that a later email
about the same job could match. Add or fix that application's Feed row by hand. `Merge Into
Feed` also fails the execution rather than write a key with an empty half, so a bug upstream
shows up in `check-live.mjs` instead of as a quiet duplicate.

The lookup compares keys lowercased and without spaces around `|`, so a hand-typed
`Acme | Backend Engineer` and a generated `acme|backend engineer` are the same application, and
the merge writes your row's key back unchanged. Anything beyond that (a `Corporation` suffix, a
different title wording) is a different key and a new row.

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
| **Classify With LLM** | **LLM Router Auth**, a *Bearer Auth* credential. Token: your router API key, without the `Bearer ` prefix (n8n adds it). Used for the OpenAI-compatible endpoint set in `scripts/build-n8n.mjs`'s `LLM_ENDPOINT`. Only called for emails the rules in `n8n/parse-email.js` couldn't classify |

This workflow doesn't call GitHub. Rebuilds come from the Feed webhook in §3.6, which fires on
every Feed write, the ingest's own upserts included. Set that up too, or new mail only reaches
the dashboard on the 6-hourly cron.

The LLM credential is a different *type* from the GitHub one (Bearer Auth vs Header Auth) on
purpose. When both were Header Auth, one credential got attached to both nodes, so the GitHub
token was sent to the LLM router on every fallback call (and the router rejected it, so the
fallback never worked). n8n only offers credentials of a node's own type, so that mix-up can't
happen again. `verify.mjs` checks it.

### 3.4 Backfill, test, then enable

The Gmail trigger only sees mail that arrives after the workflow is activated. To process what
is already in your mailbox, open **Backfill (manual)** and click *Execute workflow*. It runs the
trigger's query (up to 500 messages) through the same dedupe, writes and labels.

Check, in order:

1. `Inbox` has rows with sensible statuses and `job_platform` filled in.
2. `Feed` has one row per application, not one per email, with `Job Platform` set.
3. `Needs Review` has the rest.
4. Those emails carry `Job Application`, `Job Application/Processed` and a status label.
5. GitHub Actions shows a `repository_dispatch` run whose *Trigger source* step prints
   `source=airtable-webhook` (needs §3.6).

Run the backfill a second time. Nothing should change: no new rows and no new labels. If rows
duplicate, the matching field was lost on import. Reopen the Airtable nodes and confirm
*Column to match on* is `message_id`, or `Application Key` for **Upsert Feed**.

Then activate it.

### 3.5 The OAuth trap

A Google Cloud OAuth app left in **Testing** mode expires its refresh token after 7 days.
The workflow works for a week, then quietly stops. Publish the app, or use a service
account. This is the single most common way this kind of pipeline dies, and it dies
silently — n8n shows a credential error in the execution log and nowhere else.

That credential error now surfaces in two ways: the hourly **Ingest Backlog Check** fails when
it can't read Gmail, and `health.yml` (§3.8) emails you about the failed execution.

### 3.6 Feed edits → rebuild in seconds

Every change to Feed reaches the dashboard through a second workflow,
`n8n/job-tracker-feed-sync.json`, built by the same `scripts/build-n8n.mjs`.

This is the only thing that dispatches rebuilds, for mail as well as hand edits: the ingest
upserts Feed, and that write pings the receiver like any other.

- **Receiver.** Airtable's Webhooks API POSTs a small ping to
  `https://<your n8n>/webhook/job-tracker-feed-changed` within seconds of any change to `Feed`,
  from any source (the UI, the API, n8n itself). n8n answers 200 straight away, checks the ping
  names this base, and fires one `repository_dispatch` (`client_payload.source:
  airtable-webhook`). Bursts of edits become one deploy because `deploy.yml` cancels the
  run in progress when a newer one starts.
- **Keep-alive.** A webhook created with a personal access token **expires 7 days after it was
  created or last refreshed, even if the token itself never expires.** Airtable also switches a
  webhook's notifications off after about a day of failed pings. Once a day
  (**Daily Keep-Alive**) the workflow lists the base's webhooks and refreshes ours, re-enables
  its notifications, or creates it if none is left. The decision is `n8n/airtable-webhook.js`,
  tested by `scripts/test-airtable-webhook.mjs`. A keep-alive that can't reach Airtable fails
  its execution instead of quietly letting the webhook lapse.

Setup:

1. Add the **`webhook:manage`** scope to the Airtable token n8n uses (the read/write one from
   §3.3, not the dashboard's read-only secret).
2. If your n8n isn't at `https://n8n.shua-kyle.me`, change `NOTIFICATION_URL` in
   `n8n/airtable-webhook.js` and regenerate. `verify.mjs` checks the URL ends in the receiver's
   path.
3. n8n ▸ Import from File → `n8n/job-tracker-feed-sync.json`. On **Trigger Dashboard
   Rebuild**, set **GitHub Dispatch**: a *Header Auth* credential, name `Authorization`, value
   `Bearer github_pat_...`, a fine-grained PAT with **Contents: read and write** on this repo
   only. Set the Airtable token on the four Airtable HTTP nodes. Activate it.
4. Check the receiver routes before Airtable depends on it:
   `curl -X POST -H 'Content-Type: application/json' -d '{}' https://<your n8n>/webhook/job-tracker-feed-changed`
   must return 200, and n8n must show one execution that stopped at **Is Our Base?** (false
   branch) with no error and no dispatch.
5. Open **Register Webhook (manual)** and click *Execute workflow*. **Create Webhook** should
   return an id starting `ach`. Run it a **second** time: **Decide Webhook Action** must output
   `action: "refresh"`, not `create`. A second `create` means the list response didn't match
   what `n8n/airtable-webhook.js` expects, and it would add a duplicate webhook every day.
6. Retire the old paths, or every edit still fires twice: unpublish any older workflow that
   polls Feed, and remove any Airtable Trigger node on Feed from the ingest workflow.
7. Edit a Feed cell. **Actions** should show one `repository_dispatch` run within about 15
   seconds, and its *Trigger source* step prints `source=airtable-webhook` (that step exists
   once this change is on `main`, since `repository_dispatch` always runs `main`'s workflow).
   Make two or three more edits a few minutes apart: each should get its own receiver
   execution. Two runs for one edit means either Airtable sent a second ping (two receiver
   executions; harmless, cancel-in-progress absorbs it) or an old poller is still live (one
   receiver execution; finish step 6).

The receiver's URL is public (so is this repo), and the check on the base id only stops casual
hits. The most a deliberate one can do is start a rebuild. Checking Airtable's
`X-Airtable-Content-MAC` header would close that gap.

Don't add an Airtable polling trigger on `Feed` beside this: two paths fire two dispatches
for every edit. `verify.mjs` fails if either generated workflow has one.

### 3.7 Replacing a drifted ingest workflow

If the running ingest was edited in the n8n UI, don't patch it by hand: that's how drift
starts. `node scripts/check-live.mjs` (or the `health.yml` run) lists every difference.
To replace it:

1. n8n ▸ Import from File → `n8n/job-tracker-ingest.json`. That creates a new workflow. Set the
   credentials from §3.3, including the Bearer Auth **LLM Router Auth** on
   **Classify With LLM**.
2. Deactivate the old workflow, then archive it. `check-live.mjs` fails while two active or
   unarchived workflows share the name.
3. Activate the new one and run **Backfill (manual)** once. Mail the old workflow never labelled
   `Job Application/Processed` gets processed now. That's safe: Feed merges only move forward,
   and Inbox and Needs Review upsert on `message_id`.
4. Until the backfill has cleared that mail, **Stale Job Mail Alarm** fails every hour and
   `health.yml` will say so. That's expected. If it keeps failing after the backfill:
   - more than 500 messages were waiting: run Backfill again;
   - or the email was already *seen* once but never labelled (for example **Mark Email
     Processed** failed). **Skip Already Seen** remembers every message id it has passed, so
     Backfill drops that email too. Search Gmail with the trigger's query, find the email's row
     in Inbox or Feed, then add `Job Application/Processed` by hand. If the row is missing, clear
     Skip Already Seen's deduplication history and backfill again; that's safe, since every
     write is an upsert.

### 3.8 Health check (so you don't have to look)

`.github/workflows/health.yml` runs `scripts/check-live.mjs` hourly against the n8n API, from
outside n8n. A failed run means GitHub emails you. It fails when:

- a generated workflow is missing, duplicated or inactive on the instance;
- the live workflow differs from the generated JSON (nodes, parameters, flags, connections,
  credential types; positions and credential ids are ignored);
- a credential attached to a GitHub dispatch is also attached to any other node;
- the published (running) version differs from the draft;
- either workflow had an error execution in the last 150 minutes (wider than the hourly
  schedule, because Actions cron can run late; an error may be reported twice). That covers
  the ingest's hourly **Stale Job Mail Alarm** (job mail older than 2h still
  unprocessed), the Feed webhook keep-alive, a failed dispatch, and an expired Gmail or Airtable
  credential.

Setup: add `N8N_API_URL` and `N8N_API_KEY` (§2.5), then **Actions ▸ n8n health ▸ Run workflow**.
Add the secrets before merging `health.yml`, or it fails every hour until you do.

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

### Checking the live workflow hasn't drifted from the repo

`verify.mjs` only checks that `n8n/job-tracker-ingest.json` matches its generator — it has
no way to see whether the workflow **imported into n8n** still matches that file. It doesn't,
if someone re-exports over the import (rather than re-importing fresh) or edits a Code node
directly in the UI: n8n renames every node with a numeric suffix (`Parse Job Email` becomes
`Parse Job Email1`) the next time a file with the same node names is imported into a project
that already has them, and the two versions quietly part ways from there.

This happened here: the live workflow's `Parse Job Email1` node was running a version of
`n8n/parse-email.js` from before the `raw_text` field was added, while `Classify With LLM`'s
prompt already read `$('Parse Job Email1').item.json.raw_text` — so the LLM fallback was
sending an undefined/empty prompt to the classifier for every email the rules couldn't
handle, with `onError: continueRegularOutput` quietly swallowing the result into Needs
Review. Nothing failed loudly; the fallback just stopped doing anything.

There is no automated check for this (it would need n8n credentials in CI to compare against
a live workflow, which is a bigger tradeoff than this repo currently makes). After any parser
change, treat "diff the live Code node's content against the repo file" as part of the
re-import step, not optional: open the node in n8n and paste in `n8n/parse-email.js` (or the
relevant source file) directly, rather than trusting a prior import is still current.

---

## When something breaks

| Symptom | Cause |
|---|---|
| Smoke test gets a redirect/login page instead of 200 | Deployment Protection still on — turn it off (2.2) |
| `vercel deploy` fails with "Project not found" | `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` wrong or from a different team than the token (2.3–2.4) |
| Two deployments appear for one push | the GitHub repo got connected in Vercel's own Git integration — disconnect it (2.7) |
| Rows duplicating in `Inbox` or `Feed` | matching field lost on import (3.4) |
| Same emails reprocessed every poll | `Job Application/Processed` not applied, or not excluded in the query |
| `Needs Review` full of newsletters | trigger phrases too broad — narrow `JOB_MAIL_QUERY` (3.2) |
| `401`/`403` from Airtable | personal access token missing the right scope, or scoped to the wrong base |
| Applications not showing up at all | not under `Job Application` and no trigger phrase matches, or the backfill was never run (3.4) |
| Workflow stopped after ~a week | OAuth app still in Testing mode (3.5) |
| Scheduled builds stopped after ~2 months | GitHub disables cron after 60 days of repo inactivity; the `summary.json` commit exists to prevent this |
| Charts blank, numbers fine | ApexCharts didn't load from cdnjs; the Sankey still renders because it's server-side SVG |
