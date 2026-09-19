# Deploy runbook

Three things get set up, in this order. Each one works on its own, so stop after any of
them and you still have something running.

1. **Git** — publish the repo.
2. **VPS** — serve the dashboard, with atomic releases and one-command rollback.
3. **n8n** — feed the Airtable base from Gmail and trigger rebuilds.

Command blocks are paste-ready. `$` lines run on your laptop, `#` lines on the VPS.

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

## 2. VPS

### 2.1 Layout

```bash
# ssh into the VPS as a sudo user
sudo useradd -m -s /bin/bash deploy
sudo mkdir -p /srv/dashboard/{releases,staging,bin}
sudo chown -R deploy:deploy /srv/dashboard
```

`current` is a symlink into `releases/`. A deploy writes a new release directory and moves
the symlink; nothing is ever edited in place, so a half-finished upload can't be served.

### 2.2 Install the scripts

```bash
# from your laptop
scp deploy/activate.sh deploy/rollback.sh deploy@VPS:/srv/dashboard/bin/
ssh deploy@VPS 'chmod +x /srv/dashboard/bin/*.sh'
```

The `chmod` is a real step, not a formality — the execute bit does not survive the copy,
and the deploy fails at the last hop with `Permission denied` if you skip it.

### 2.3 Seed a first release

The web server needs `current` to exist before it will start.

```bash
# laptop
FEED_FIXTURE=./sample-feed.json node scripts/build.mjs
rsync -az --delete dist/ deploy@VPS:/srv/dashboard/staging/
ssh deploy@VPS '/srv/dashboard/bin/activate.sh seed'
```

### 2.4 Web server

Caddy (`deploy/Caddyfile.example`) or nginx (`deploy/nginx-dashboard.conf.example`). Copy
the one you use, change the hostname, reload.

If you use nginx, keep `disable_symlinks off;`. nginx caches the resolved path behind a
symlink, so without it your next deploy swaps `current` and nginx keeps serving the old
release until you restart it — which looks exactly like a broken deploy.

If your reverse proxy runs in Docker and can't see `/srv/dashboard`, use
`deploy/docker-compose.dashboard.yml` instead: an nginx container with the release mounted
read-only.

### 2.5 Deploy key

```bash
# laptop
ssh-keygen -t ed25519 -f ./deploy_key -N "" -C "github-actions"
ssh-copy-id -i ./deploy_key.pub deploy@VPS
ssh-keyscan -p 22 VPS_HOST > known_hosts.txt   # pin the host key
```

`ssh-keyscan` matters. The alternative people reach for is
`StrictHostKeyChecking=no`, which tells the runner to trust whatever answers on that
address — which is the entire attack it's meant to prevent.

### 2.6 Secrets

**Settings ▸ Secrets and variables ▸ Actions**

| Secret | Value |
|---|---|
| `AIRTABLE_API_KEY` | personal access token scoped to `data.records:read` on this base |
| `AIRTABLE_BASE_ID` | the base ID (`appXXXXXXXXXXXXXX`), from **Help ▸ API documentation** |
| `AIRTABLE_TABLE_NAME` | optional — only if the tracker table isn't named `Feed` |
| `SSH_PRIVATE_KEY` | contents of `./deploy_key` |
| `SSH_KNOWN_HOSTS` | contents of `known_hosts.txt` |
| `SSH_HOST` | VPS hostname or IP |
| `SSH_USER` | `deploy` |
| `SSH_PORT` | `22` (omit if 22) |
| `PUBLIC_URL` | `https://your-domain/` |

Then delete `deploy_key` from your laptop. It's in GitHub now; a second copy is only a
second thing to lose.

### 2.7 First deploy

**Actions ▸ Build and deploy ▸ Run workflow.**

The run verifies, builds from the live feed, commits the summary, uploads to staging,
activates, then curls the public URL and fails if it doesn't come back 200 with the
expected markup. A green run means the page is actually up, not that files were copied.

### 2.8 Rollback

```bash
ssh deploy@VPS '/srv/dashboard/bin/rollback.sh --list'
ssh deploy@VPS '/srv/dashboard/bin/rollback.sh'                      # previous release
ssh deploy@VPS '/srv/dashboard/bin/rollback.sh 20260918T101530Z-a1b2c3d'
```

Five releases are kept. Rollback is a symlink move, so it takes about as long as the SSH
handshake.

---

## 3. n8n

### 3.1 Two new Airtable tables

n8n does not write to your `Feed` table. It writes to two new ones, in the same base, and
you stay the only thing that edits the tracker.

Create a table named `Inbox` with these fields:

```
message_id  thread_id  received_at  company  job_title  status  max_stage  source  confidence
```

Create a table named `Needs Review` with these fields:

```
message_id  thread_id  received_at  from_address  subject  status  company  job_title  confidence
```

`message_id` should be each table's primary field, and every field can be Single line text
except `max_stage` (Number) — the n8n workflow's Airtable node upserts against `message_id`
regardless of field type, but a plain text primary field is the simplest thing that can't
silently coerce an ID.

Why a separate table instead of writing straight into the tracker: an email tells you about
a *message*, not an *application*. Two emails about the same job are two messages. Keying
rows on `message_id` (via Airtable's upsert operation) makes every write idempotent — a
re-poll updates the same row instead of adding a duplicate — but it means `Inbox` is a log,
not a row-per-application. You read it, you decide, you update `Feed`. That's a deliberate
trade: the automation gets to be provably correct because it isn't allowed to guess.

To see what's new without scrolling, add a `Filed` checkbox field to `Inbox` and filter the
default view to `Filed = false`. Tick it once you've copied a row's details into `Feed`.

### 3.2 Two Gmail labels

The trigger query is `label:job-applications -label:tracker-processed`. Two labels, one
job each — don't merge them.

| Label | Applied by | Means |
|---|---|---|
| `job-applications` | a Gmail filter | in scope |
| `tracker-processed` | the workflow | already handled |

Create both: Gmail ▸ Settings ▸ Labels ▸ Create new label.

**Why the scoping label exists.** Without it the trigger polls your whole mailbox. Every
newsletter and receipt gets its full body fetched, parsed, written to `Needs Review` and
labelled — a junk drawer in Airtable and litter in Gmail. Gmail filters run server-side
for free, so the narrowing belongs there, where n8n never has to see the mail at all.

### 3.2a The Gmail filter

Gmail ▸ Settings ▸ Filters and blocked addresses ▸ **Create a new filter**. Put this in
**Has the words**:

```
from:(linkedin.com OR jobstreet.com OR indeed.com OR onlinejobs.ph OR greenhouse.io OR lever.co OR myworkday.com OR ashbyhq.com OR smartrecruiters.com OR workable.com OR bamboohr.com) OR subject:("thank you for applying" OR "thanks for applying" OR "application received" OR "application was sent" OR "your application" OR "application update" OR "application status" OR "interview" OR "assessment" OR "offer of employment" OR "not moving forward" OR "regret to inform")
```

Create filter → tick **Apply the label** → `job-applications` → and tick **Also apply
filter to matching conversations**.

That last checkbox is how you backfill. It retro-labels everything already in your
mailbox, and n8n drains it 25 messages per poll until it catches up. Skip it and only
future mail gets tracked.

**Tuning it.** Too broad and noise reaches `needs-review`; too narrow and applications go
missing — and missing is the expensive direction, because you never find out. Start broad.
Once `needs-review` has a week of rows, look at what's actually landing there and tighten
the filter, not the parser. Adding a sender to the Gmail filter is a UI click; changing the
parser is a code change, a test, a regenerate and a re-import.

The parser is the second filter anyway: anything inside `job-applications` it can't
classify still lands in `needs-review` rather than corrupting the tracker.

### 3.3 Import

n8n ▸ Workflows ▸ Import from File → `n8n/job-tracker-ingest.json`.

Then fill in the four things the file can't know:

| Node | What to set |
|---|---|
| **Poll Gmail** | pick your Gmail credential |
| **Write to Inbox** / **Write to Needs Review** | pick your Airtable Personal Access Token credential (a *second* token, scoped to `data.records:write` on this base — the `AIRTABLE_API_KEY` secret in §2.6 is read-only and belongs only to the dashboard build) |
| **Mark Email Processed** | same Gmail credential; pick `tracker-processed` from the label dropdown |
| **Trigger Dashboard Rebuild** | change `REPLACE_OWNER/REPLACE_REPO` in the URL |

The two Airtable nodes also need their `base`/`table` resource locators repointed at your real
base and the `Inbox` / `Needs Review` tables — the generator hard-codes placeholder IDs
(`appJobTrackerIngest01` etc.) the same way it always hard-coded the old spreadsheet ID, because
a resource locator in `id` mode imports ready to click, where `list` mode imports blank.

For the rebuild node's auth, create a **Header Auth** credential:

- Name: `Authorization`
- Value: `Bearer ghp_...` — a fine-grained PAT with **Contents: read and write** on this
  repo only

### 3.4 Test before you enable it

Open **Poll Gmail** and hit *Fetch Test Event*, then run the workflow manually once.

Check, in order:

1. `Inbox` got rows and the statuses look right.
2. `Needs Review` got the rest — newsletters, recruiter spam.
3. Those emails now carry the `tracker-processed` label.
4. GitHub Actions shows a run triggered by `repository_dispatch`.

Run it a second time. Nothing should change: no new rows, no second Actions run. If rows
duplicate, the matching field got lost on import — reopen both Airtable nodes and confirm
the upsert's *Column to match on* is `message_id`.

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
| Deploy green, page unchanged | nginx without `disable_symlinks off;` |
| `Permission denied` on activate | forgot `chmod +x` in 2.2 |
| Smoke test fails, files are there | web server not pointed at `/srv/dashboard/current` |
| Rows duplicating in `Inbox` | matching field lost on import (3.4) |
| Same emails reprocessed every poll | `tracker-processed` not applied, or not excluded in the query |
| `Needs Review` full of newsletters | Gmail filter too broad — tighten the filter, not the parser (3.2a) |
| `401`/`403` from Airtable | personal access token missing the right scope, or scoped to the wrong base |
| Applications not showing up at all | Gmail filter too narrow, or you skipped *Also apply to matching conversations* |
| Workflow stopped after ~a week | OAuth app still in Testing mode (3.5) |
| Scheduled builds stopped after ~2 months | GitHub disables cron after 60 days of repo inactivity; the `summary.json` commit exists to prevent this |
| Charts blank, numbers fine | ApexCharts didn't load from cdnjs; the Sankey still renders because it's server-side SVG |
