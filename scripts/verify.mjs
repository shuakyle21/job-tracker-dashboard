#!/usr/bin/env node
/**
 * Pre-deploy gate. Builds against the checked-in fixture and asserts the things
 * that must be true of any correct build, then checks the real feed produces a
 * page at all.
 *
 * Why this exists: once Actions deploys straight to the VPS, a bad commit reaches
 * production with nothing in between. The cheapest insurance is a handful of
 * invariants that a broken aggregation cannot satisfy.
 *
 *   node scripts/verify.mjs            # fixture only (no network, no secret)
 *   node scripts/verify.mjs --live     # also build once against AIRTABLE_API_KEY/AIRTABLE_BASE_ID
 */

import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.error(`  FAIL  ${name}${detail ? "  — " + detail : ""}`);
    failures++;
  }
}

async function build(overrides) {
  await rm(join(ROOT, "dist"), { recursive: true, force: true });
  // Blank out every ingestion env var first so a leftover value from the
  // caller's shell can't silently override the mode this call asks for.
  const env = {
    ...process.env,
    FEED_FIXTURE: "",
    AIRTABLE_API_KEY: "",
    AIRTABLE_BASE_ID: "",
    AIRTABLE_TABLE_NAME: "",
    ...overrides,
  };
  await run("node", ["scripts/build.mjs"], { cwd: ROOT, env });
}

async function assertBuildOutput(label) {
  const summary = JSON.parse(await readFile(join(ROOT, "data/summary.json"), "utf8"));
  const html = await readFile(join(ROOT, "dist/index.html"), "utf8");
  const artifact = await readFile(join(ROOT, "dist/artifact.html"), "utf8");
  const distSummaryRaw = await readFile(join(ROOT, "dist/data/summary.json"), "utf8");
  const { reached, atStage, total, sent, unsent, replied, noReply } = summary;

  console.log(`\n${label}`);

  // --- arithmetic that must hold for any dataset ---------------------
  check("funnel is monotonically non-increasing",
    reached.every((v, i) => i === 0 || v <= reached[i - 1]),
    reached.join(" → "));

  check("stage 1 reach equals the row count",
    reached[0] === total, `${reached[0]} vs ${total}`);

  check("per-stage counts sum to the total",
    atStage.reduce((a, b) => a + b, 0) === total,
    `${atStage.reduce((a, b) => a + b, 0)} vs ${total}`);

  check("sent + unsent equals total",
    sent + unsent === total, `${sent} + ${unsent} vs ${total}`);

  check("replied + noReply equals sent",
    replied + noReply === sent, `${replied} + ${noReply} vs ${sent}`);

  check("status counts sum to the total",
    summary.byStatus.reduce((a, s) => a + s.count, 0) === total);

  check("channel sent+unsent sums to the total",
    summary.channels.reduce((a, c) => a + c.sent + c.unsent, 0) === total);

  // Each drop-off label must add up to its own ribbon — this is the exact bug the
  // first Sankey shipped with, so it gets a permanent test.
  check("drop-off composition matches each stage bucket",
    summary.dropComposition.every((list, i) =>
      list.reduce((a, c) => a + c.count, 0) === atStage[i]),
    summary.dropComposition.map((l, i) => `${l.reduce((a, c) => a + c.count, 0)}/${atStage[i]}`).join(" "));

  // The Sankey's red branches are carved out of the drop-off buckets above, so
  // they must fit inside them and add up to every "Rejected" row.
  const rejectedRows = summary.byStatus
    .filter(s => s.status.toLowerCase() === "rejected").reduce((a, s) => a + s.count, 0);
  check("rejections by stage sum to the Rejected status count",
    summary.rejectedAt.reduce((a, b) => a + b, 0) === rejectedRows && summary.rejected === rejectedRows,
    `${summary.rejectedAt.join("+")} vs ${rejectedRows}`);
  check("rejections never exceed their stage's drop-off",
    summary.rejectedAt.every((n, i) => n >= 0 && n <= atStage[i]),
    summary.rejectedAt.map((n, i) => `${n}/${atStage[i]}`).join(" "));

  check("rates are within 0..1 or null",
    [summary.replyRate, summary.interviewRate, summary.ghostRate, summary.rejectionRate]
      .every(r => r === null || (r >= 0 && r <= 1)));

  // --- the page actually contains what it claims to ------------------
  check("no unfilled template placeholders", !html.includes("{{"));
  check("Sankey SVG is server-rendered", /<svg viewBox="0 0 1000 \d+"/.test(html));
  check("Sankey draws a rejected branch when there are rejections",
    summary.rejectedAt.slice(0, 4).every(n => n === 0) || /class="sk-rej"/.test(html));
  check("ApexCharts is loaded from the allowed CDN",
    html.includes("cdnjs.cloudflare.com/ajax/libs/apexcharts/"));
  check("Tailwind is loaded", html.includes("cdn.tailwindcss.com"));
  check("data payload is embedded", html.includes('"reached"'));
  check("standalone page has a doctype", /^<!doctype html>/i.test(html.trim()));
  check("artifact variant has no skeleton",
    !/<!doctype|<html|<body/i.test(artifact));

  // The live page fetches dist/data/summary.json to notice a newer build landed.
  // It must always match what's baked into this same build's HTML, or the banner
  // would fire (or stay silent) on a false signal.
  check("dist/data/summary.json matches data/summary.json",
    distSummaryRaw === JSON.stringify(summary, null, 2) + "\n");

  // --- the privacy boundary ------------------------------------------
  // The Feed table is de-identified by construction, but a widened feed would
  // leak silently. Fail the build instead. Airtable field names change (Title
  // Case, spaces) but company names and emails would still match these
  // patterns however the source field was renamed.
  // dist/data/summary.json ships in the same deployed dist/ tree as artifact.html
  // (the live page fetches it), so it gets the same scrutiny.
  const forbidden = [/@[a-z0-9.-]+\.(com|ph|org|net|co)\b/i, /\bInc\.\b/, /\bLtd\b/, /\bCorporation\b/];
  const hits = forbidden.filter(re => re.test(artifact.replace(/wght@\d+/g, "")) || re.test(distSummaryRaw));
  check("no company names or emails in the published output",
    hits.length === 0, hits.map(String).join(", "));

  // Airtable base/table IDs and API keys are config, not analytics — they must
  // never reach a page the build can also publish as a public GitHub Pages site.
  check("no Airtable API endpoints or credentials leak into the published output",
    !/api\.airtable\.com/i.test(artifact) && !/\bAIRTABLE_API_KEY\b/.test(artifact) &&
    !/api\.airtable\.com/i.test(distSummaryRaw) && !/\bAIRTABLE_API_KEY\b/.test(distSummaryRaw));

  return summary;
}

async function assertIngestWorkflow() {
  console.log("\nn8n ingest workflow");

  // The parser has tests; run them here so a bad regex cannot reach the VPS
  // deploy or an n8n import.
  let parserOk = true;
  try {
    await run("node", ["scripts/test-parser.mjs"], { cwd: ROOT });
  } catch { parserOk = false; }
  check("parser tests pass", parserOk);

  let mergeOk = true;
  try {
    await run("node", ["scripts/test-merge-feed.mjs"], { cwd: ROOT });
  } catch { mergeOk = false; }
  check("Feed merge tests pass", mergeOk);

  let llmFallbackOk = true;
  try {
    await run("node", ["scripts/test-llm-fallback.mjs"], { cwd: ROOT });
  } catch { llmFallbackOk = false; }
  check("LLM fallback tests pass", llmFallbackOk);

  // The workflow JSON is generated. If someone edits it in the n8n UI and
  // re-exports over this file, the tested parser and the running parser part
  // ways silently — which is the failure this check exists to make loud.
  const { ingest: regenerated } = await regenerateWorkflows();

  const wf = JSON.parse(regenerated);
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const parserFile = await readFile(join(ROOT, "n8n/parse-email.js"), "utf8");

  check("embedded parser is the tested file",
    byName["Parse Job Email"]?.parameters.jsCode === parserFile);

  const mergeFile = await readFile(join(ROOT, "n8n/merge-feed.js"), "utf8");
  check("embedded Feed merge is the tested file",
    byName["Merge Into Feed"]?.parameters.jsCode === mergeFile);

  const llmFallbackFile = await readFile(join(ROOT, "n8n/llm-fallback.js"), "utf8");
  check("embedded LLM fallback is the tested file",
    byName["Apply LLM Fallback"]?.parameters.jsCode === llmFallbackFile);

  // A slow or down LLM router must never stall Gmail polling — the item has
  // to fall through to Needs Review, not hang the whole execution.
  check("LLM fallback degrades gracefully on error",
    byName["Classify With LLM"]?.onError === "continueRegularOutput");

  // Exactly-once. The Gmail query must exclude the label the workflow applies,
  // or the label is decoration and every poll reprocesses every email.
  const q = byName["Poll Gmail"]?.parameters.filters?.q ?? "";
  check("Gmail query excludes the processed label", /-label:job-application-processed\b/.test(q), q);

  // Without a positive scope the trigger polls the whole mailbox — every
  // newsletter gets a full body fetch, a needs-review row and a label. This
  // shipped once; it does not ship again.
  check("Gmail query is scoped to job mail", /(?:^|[\s(])label:job-application(?!-)\b/.test(q), q);

  // The backfill must see exactly what the trigger sees, or it processes a
  // different set of mail than production would.
  check("backfill uses the trigger's query",
    byName["Fetch Job Mail"]?.parameters.filters?.q === q);

  // Every sub-label the parser can choose must exist as a Gmail label id, or
  // addLabels fails for that email and it is re-polled forever.
  const labels = JSON.parse(await readFile(join(ROOT, "n8n/gmail-labels.json"), "utf8"));
  const statusBlock = parserFile.match(/const STATUS_LABELS = \{([\s\S]*?)\};/)?.[1] ?? "";
  const labelNames = [...statusBlock.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]).concat("Needs Review");
  const missing = labelNames.filter((n) => !/^Label_\w+$/.test(labels.status[n] ?? ""));
  check("every parser status_label has a Gmail label id", labelNames.length > 1 && missing.length === 0, missing.join(", "));

  // n8n/llm-fallback.js keeps its own copy of STATUS_LABELS (Code nodes can't
  // import from each other) — this is the guard against it silently drifting
  // from the parser's copy.
  const fallbackStatusBlock = llmFallbackFile.match(/const STATUS_LABELS = \{([\s\S]*?)\};/)?.[1] ?? "";
  const parse = (block) => Object.fromEntries(
    [...block.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
  check("LLM fallback statuses match the parser's STATUS_LABELS",
    statusBlock.length > 0 && JSON.stringify(parse(statusBlock)) === JSON.stringify(parse(fallbackStatusBlock)));

  const markIds = byName["Mark Email Processed"]?.parameters.labelIds ?? [];
  check("processed email gets scope, processed and status labels",
    markIds[0]?.includes(labels.scope) && /\.parsed\b/.test(markIds[0])
      && markIds[1] === labels.processed && /status_label/.test(markIds[2] ?? ""));

  // The label must be applied after the rows are written. Inverted, a crash
  // between the two consumes the email without producing its row. On the
  // classified branch the last write is the Feed upsert.
  const labelSources = Object.entries(wf.connections)
    .filter(([, c]) => c.main.some((o) => o.some((t) => t.node === "Mark Email Processed")))
    .map(([s]) => s);
  check("label is applied after all Airtable writes",
    labelSources.length === 2 && labelSources.includes("Upsert Feed") && labelSources.includes("Write to Needs Review"),
    labelSources.join(", "));

  check("unclassified email has its own branch",
    wf.connections["Classified?"]?.main[1]?.[0]?.node === "Write to Needs Review");

  check("rows key on message_id in both tables",
    ["Write to Inbox", "Write to Needs Review"].every(
      (n) => byName[n]?.parameters.columns.matchingColumns?.[0] === "message_id"));

  // The whole point of the migration: writes must actually go to Airtable, via
  // an upsert (so message_id keeps its dedupe-on-re-poll behaviour), not a
  // leftover or reintroduced Google Sheets node.
  check("both writes target Airtable via upsert",
    ["Write to Inbox", "Write to Needs Review"].every(
      (n) => byName[n]?.type === "n8n-nodes-base.airtable" && byName[n]?.parameters.operation === "upsert"));

  // One Feed row per application: the upsert key must be the application,
  // not the message, or every follow-up email becomes a new tracker row.
  check("Feed is upserted on Application Key",
    byName["Upsert Feed"]?.type === "n8n-nodes-base.airtable"
      && byName["Upsert Feed"]?.parameters.operation === "upsert"
      && byName["Upsert Feed"]?.parameters.columns.matchingColumns?.join() === "Application Key");

  check("Feed row lookup survives a miss",
    byName["Find Feed Row"]?.alwaysOutputData === true
      && wf.connections["Find Feed Row"]?.main[0]?.[0]?.node === "Merge Into Feed");

  // Find Feed Row must only ever see one email per call: a multi-item batch
  // where every search misses collapses to one output item paired with every
  // input, which throws "Multiple matches" in Merge Into Feed (hit at 36
  // emails in production). Loop Feed Rows pins batch size to 1 so the
  // collapse can't happen, done -> Upsert Feed and loop -> Find Feed Row.
  check("Feed row lookup runs one email at a time",
    byName["Loop Feed Rows"]?.type === "n8n-nodes-base.splitInBatches"
      && byName["Loop Feed Rows"]?.parameters.batchSize === 1
      && wf.connections["Write to Inbox"]?.main[0]?.[0]?.node === "Loop Feed Rows"
      && wf.connections["Loop Feed Rows"]?.main[0]?.[0]?.node === "Upsert Feed"
      && wf.connections["Loop Feed Rows"]?.main[1]?.[0]?.node === "Find Feed Row"
      && wf.connections["Merge Into Feed"]?.main[0]?.[0]?.node === "Loop Feed Rows");

  check("Inbox and Needs Review write to distinct Airtable tables",
    byName["Write to Inbox"]?.parameters.table?.value !== byName["Write to Needs Review"]?.parameters.table?.value);

  // Feed now carries employer names for n8n's benefit. The dashboard must
  // never read them — FIELD_MAP is the whitelist that guarantees it.
  const buildSrc = await readFile(join(ROOT, "scripts/build.mjs"), "utf8");
  const fieldMap = buildSrc.match(/const FIELD_MAP = \{([\s\S]*?)\};/)?.[1] ?? "";
  check("build never reads Feed's identifying fields",
    fieldMap.length > 0 && !/"(?:Company|Job Role|Application Key)"/.test(fieldMap));

  check("no Google Sheets nodes remain in the workflow",
    !wf.nodes.some((n) => n.type === "n8n-nodes-base.googleSheets"));

  // Feed-sync dispatches on every Feed write, the ingest's included. A second
  // dispatch here would bring back the paired cancelled+passed runs.
  check("ingest leaves the rebuild to the Feed webhook",
    !wf.nodes.some((n) => /\/dispatches$/.test(n.parameters?.url ?? "")));

  assertGraph(wf, ["Poll Gmail", "Backfill (manual)"]);
  return wf;
}

// Every node no trigger can reach is a node that never runs, and a connection
// naming a node that isn't there blocks the import.
function assertGraph(wf, triggers) {
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const reachable = new Set(triggers);
  for (let i = 0; i < wf.nodes.length; i++) {
    for (const [src, conn] of Object.entries(wf.connections)) {
      if (!reachable.has(src)) continue;
      for (const out of conn.main) for (const t of out) reachable.add(t.node);
    }
  }
  const orphans = wf.nodes
    .filter((n) => n.type !== "n8n-nodes-base.stickyNote" && !reachable.has(n.name))
    .map((n) => n.name);
  check("no unreachable nodes", orphans.length === 0, orphans.join(", "));

  const dangling = Object.entries(wf.connections).flatMap(([src, c]) =>
    [...(byName[src] ? [] : [src]), ...c.main.flat().map((t) => t.node).filter((n) => !byName[n])]);
  check("all connections resolve to real nodes", dangling.length === 0, dangling.join(", "));
}

// The workflow JSON is generated. If someone edits it in the n8n UI and
// re-exports over the file, the tested code and the running code part ways
// silently — which is the failure these checks exist to make loud. Runs the
// generator once and returns both files as it wrote them.
let generated;
async function regenerateWorkflows() {
  if (generated) return generated;
  const files = { ingest: "n8n/job-tracker-ingest.json", sync: "n8n/job-tracker-feed-sync.json" };
  const read = (f) => readFile(join(ROOT, f), "utf8").catch(() => "");
  const committed = { ingest: await read(files.ingest), sync: await read(files.sync) };
  await run("node", ["scripts/build-n8n.mjs"], { cwd: ROOT });
  generated = { ingest: await read(files.ingest), sync: await read(files.sync) };
  check("workflow JSON matches its generator", committed.ingest === generated.ingest,
    "run: node scripts/build-n8n.mjs");
  check("Feed sync workflow JSON matches its generator", committed.sync === generated.sync,
    "run: node scripts/build-n8n.mjs");
  return generated;
}

async function assertSyncWorkflow() {
  console.log("\nn8n Feed sync workflow");

  let keepAliveOk = true;
  try {
    await run("node", ["scripts/test-airtable-webhook.mjs"], { cwd: ROOT });
  } catch { keepAliveOk = false; }
  check("webhook keep-alive tests pass", keepAliveOk);

  const wf = JSON.parse((await regenerateWorkflows()).sync);
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const keepAliveFile = await readFile(join(ROOT, "n8n/airtable-webhook.js"), "utf8");
  check("embedded webhook keep-alive is the tested file",
    byName["Decide Webhook Action"]?.parameters.jsCode === keepAliveFile);

  // The URL the keep-alive registers with Airtable and the path n8n listens
  // on are written in two places; if they disagree, pings go nowhere.
  const receiver = byName["Airtable Feed Changed"];
  const notificationUrl = keepAliveFile.match(/const NOTIFICATION_URL = '([^']+)'/)?.[1] ?? "";
  check("registered URL is the receiver's production URL",
    receiver?.type === "n8n-nodes-base.webhook"
      && notificationUrl.startsWith("https://")
      && notificationUrl.endsWith(`/webhook/${receiver.parameters.path}`),
    `${notificationUrl} vs path ${receiver?.parameters.path}`);

  // Airtable disables a webhook's notifications after ~a day of failed pings,
  // so the receiver must answer before it does any work.
  check("receiver answers the ping immediately", receiver?.parameters.responseMode === "onReceived");

  const generatorSrc = await readFile(join(ROOT, "scripts/build-n8n.mjs"), "utf8");
  const feedTable = generatorSrc.match(/const FEED_TABLE_ID = "([^"]+)"/)?.[1];
  check("webhook is scoped to the Feed table",
    Boolean(feedTable) && keepAliveFile.includes(`const FEED_TABLE_ID = '${feedTable}'`)
      && /recordChangeScope: FEED_TABLE_ID/.test(keepAliveFile));

  check("ping reaches the rebuild only through the base check",
    wf.connections["Airtable Feed Changed"]?.main[0]?.[0]?.node === "Is Our Base?"
      && wf.connections["Is Our Base?"]?.main[0]?.[0]?.node === "Trigger Dashboard Rebuild");

  check("sync rebuild fires once per ping", byName["Trigger Dashboard Rebuild"]?.executeOnce === true);

  // Nothing runs after the dispatch, so swallowing its error would only turn a
  // revoked GitHub token into green executions and a dashboard that stops moving.
  check("sync rebuild fails loudly", !byName["Trigger Dashboard Rebuild"]?.onError);

  // The keep-alive failing is the loud signal. Swallowing its errors would let
  // the webhook expire quietly and put hand edits back on the 6-hourly cron.
  const keepAliveCalls = ["List Airtable Webhooks", "Create Webhook", "Refresh Webhook", "Enable Notifications"];
  check("keep-alive Airtable calls fail loudly",
    keepAliveCalls.every((n) => byName[n] && !byName[n].onError));

  check("keep-alive runs on a schedule",
    wf.connections["Daily Keep-Alive"]?.main[0]?.[0]?.node === "List Airtable Webhooks");

  assertGraph(wf, ["Airtable Feed Changed", "Daily Keep-Alive", "Register Webhook (manual)"]);
  return wf;
}

// Both workflows call GitHub and one calls the LLM router. A shared credential
// once sent the GitHub token to the router on every fallback call; giving the
// two different credential types makes that impossible to repeat on import.
function assertCredentials(workflows) {
  console.log("\nCredentials and triggers (both workflows)");
  const nodes = workflows.flatMap((wf) => wf.nodes);
  const dispatchers = nodes.filter((n) => /api\.github\.com\/.*\/dispatches/.test(n.parameters?.url ?? ""));
  check("every GitHub dispatch uses the GitHub Dispatch header credential",
    dispatchers.length > 0 && dispatchers.every((n) =>
      n.parameters.genericAuthType === "httpHeaderAuth"
        && n.credentials?.httpHeaderAuth?.name === "GitHub Dispatch"
        && Object.keys(n.credentials).length === 1),
    `${dispatchers.length} dispatch node(s)`);

  const llm = nodes.find((n) => n.name === "Classify With LLM");
  check("LLM router uses its own Bearer credential",
    /^https:\/\/llmrouter\.[^/]+\/v1\/chat\/completions$/.test(llm?.parameters.url ?? "")
      && llm?.parameters.genericAuthType === "httpBearerAuth"
      && llm?.credentials?.httpBearerAuth?.name === "LLM Router Auth"
      && Object.keys(llm.credentials).length === 1);

  // Airtable's credential is the only one that may appear on api.airtable.com
  // calls, and the GitHub credential must appear nowhere else.
  const githubElsewhere = nodes.filter((n) => n.credentials?.httpHeaderAuth && !dispatchers.includes(n));
  check("GitHub credential is used only for dispatches",
    githubElsewhere.length === 0, githubElsewhere.map((n) => n.name).join(", "));

  // Feed hand edits arrive by webhook now. A polling trigger on Feed next to
  // it doubles every dispatch (this happened: two runs per edit, 23s apart).
  const pollers = nodes.filter((n) => n.type === "n8n-nodes-base.airtableTrigger");
  check("no Airtable polling trigger remains", pollers.length === 0, pollers.map((n) => n.name).join(", "));
}

console.log("Verifying build\n");
await build({ FEED_FIXTURE: "./sample-feed.json" });
const fixture = await assertBuildOutput("Fixture build");
const ingestWf = await assertIngestWorkflow();
const syncWf = await assertSyncWorkflow();
assertCredentials([ingestWf, syncWf]);

// Known-good numbers for the checked-in fixture. If aggregation logic changes
// intentionally, update these; if it changes by accident, this catches it.
console.log("\nFixture regression");
check("funnel is 97 → 31 → 12 → 3 → 0", fixture.reached.join(",") === "97,31,12,3,0", fixture.reached.join(","));
check("93 sent, 4 unsent", fixture.sent === 93 && fixture.unsent === 4);
check("reply rate is 49.5%", Math.round(fixture.replyRate * 1000) === 495);
check("five months of history", fixture.monthly.length === 5);
check("rejected by stage is 15,2,0,2,0", fixture.rejectedAt.join(",") === "15,2,0,2,0", fixture.rejectedAt.join(","));

if (process.argv.includes("--live")) {
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    console.error("\n--live needs AIRTABLE_API_KEY and AIRTABLE_BASE_ID set");
    process.exit(1);
  }
  await build({
    AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
    AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
    AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || "",
  });
  const live = await assertBuildOutput("Live feed build");
  check("live feed returned rows", live.total > 0);
  // Rebuild from the fixture so dist/ is deterministic if anything reads it after.
  await build({ FEED_FIXTURE: "./sample-feed.json" });
}

console.log(failures ? `\n${failures} check(s) failed\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
