#!/usr/bin/env node
/**
 * Generates n8n/job-tracker-ingest.json — the file you import into n8n.
 *
 * The workflow is generated rather than hand-edited for one reason: the Code
 * node's body is n8n/parse-email.js, which has tests. If the JSON were the
 * source of truth, the tested parser and the running parser would drift the
 * first time someone edited the workflow in the n8n UI and re-exported it.
 * scripts/verify.mjs re-runs this and fails if the committed JSON differs.
 *
 *   node scripts/build-n8n.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const parserSource = await readFile(join(ROOT, "n8n/parse-email.js"), "utf8");
const mergeSource = await readFile(join(ROOT, "n8n/merge-feed.js"), "utf8");
// Gmail label ids for "Job Application", "Job Application/Processed" and one
// sub-label per parser status_label. Ids, not names: the Gmail node's
// addLabels takes ids, and a renamed label keeps its id.
const LABELS = JSON.parse(await readFile(join(ROOT, "n8n/gmail-labels.json"), "utf8"));

// Two ways in, one exit. Mail already under "Job Application" is in scope by
// definition; the phrases catch confirmations nobody labelled yet — that is
// the auto-labelling. Excluding Processed (applied last, after every write) is
// what stops the trigger re-delivering the same email forever.
const JOB_MAIL_QUERY = "(label:job-application"
  + ' OR "thank you for applying" OR "thanks for applying" OR "application has been received"'
  + ' OR "received your application" OR "successfully submitted" OR "your application was sent"'
  + ' OR "application sent to" OR "has viewed your application" OR "your application was viewed"'
  + ' OR "update on your application" OR subject:"your application" OR subject:"application received")'
  + " -label:job-application-processed -in:chats";

// The live base and its tables. Hard-coded on purpose: a resource locator in
// `id` mode imports ready to run, where `list` mode imports blank and has to
// be picked by hand in every node. IDs are not secrets — the token is.
// Inbox/Needs Review are n8n's message-level ingest log; Feed is the tracker
// scripts/build.mjs reads, one row per application, which n8n now upserts.
const BASE_ID = "appRlqw66Sxzjpnf6";
const INBOX_TABLE_ID = "tbl2ASezOoTqS4qok";
const REVIEW_TABLE_ID = "tblwEyImuS3hgYGFK";
const FEED_TABLE_ID = "tblPZSpJ8P4iFuAhX";

// n8n expressions are plain strings that begin with "=".
const ex = (s) => `=${s}`;

// Both tables take the same shape, so build the resourceMapper once. The row
// key is message_id: one Gmail message produces exactly one row, forever. That
// makes a re-poll a no-op update rather than a duplicate, which is the whole
// dedupe story at the storage layer.
function columns(fields, key = "message_id") {
  return {
    mappingMode: "defineBelow",
    matchingColumns: [key],
    value: Object.fromEntries(fields.map((f) => [f, ex(`{{ $json[${JSON.stringify(f)}] }}`)])),
    schema: fields.map((f) => ({
      id: f,
      displayName: f,
      required: false,
      defaultMatch: f === key,
      display: true,
      type: f === "max_stage" || f === "Max Stage" ? "number" : "string",
      canBeUsedToMatch: true,
    })),
  };
}

const INBOX_FIELDS = [
  "message_id", "thread_id", "received_at", "company", "job_title",
  "status", "max_stage", "source", "confidence", "job_platform",
];
const REVIEW_FIELDS = [
  "message_id", "thread_id", "received_at", "from_address", "subject",
  "status", "company", "job_title", "confidence",
];

// Merge Into Feed returns exactly these, so the upsert writes a full row and
// never blanks a field by leaving it out.
const FEED_FIELDS = [
  "Application Key", "Job Role", "Company", "Job Platform", "Source",
  "Date Applied", "Status", "Max Stage",
];

function airtableNode(name, tableId, fields, position, key = "message_id") {
  return {
    parameters: {
      authentication: "airtableTokenApi",
      resource: "record",
      operation: "upsert",
      base: { __rl: true, mode: "id", value: BASE_ID },
      table: { __rl: true, mode: "id", value: tableId },
      columns: columns(fields, key),
      options: { typecast: true },
    },
    type: "n8n-nodes-base.airtable",
    typeVersion: 2.1,
    position,
    id: `airtable-${tableId}`,
    name,
    // An Airtable hiccup must not strand the email unlabelled and un-rebuilt.
    // Continuing on error keeps the chain moving; the execution log still shows
    // the failure, and the next poll retries the row because the label was the
    // thing that would have excluded it.
    onError: "continueRegularOutput",
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    credentials: { airtableTokenApi: { id: "REPLACE_ME", name: "Airtable account" } },
  };
}

const nodes = [
  {
    parameters: {
      pollTimes: { item: [{ mode: "everyX", value: 15, unit: "minutes" }] },
      simple: false,
      maxResults: 25,
      filters: {
        // Never an empty or label-free query: without a positive scope the
        // trigger polls the entire mailbox, and every newsletter gets a full
        // body fetch, a needs-review row and a label.
        q: JOB_MAIL_QUERY,
        readStatus: "both",
        includeSpamTrash: false,
        includeDrafts: false,
      },
      options: {},
    },
    type: "n8n-nodes-base.gmailTrigger",
    typeVersion: 1.4,
    position: [0, 300],
    id: "gmail-trigger",
    name: "Poll Gmail",
    credentials: { gmailOAuth2: { id: "REPLACE_ME", name: "Gmail account" } },
  },
  // Backfill: the Gmail trigger only sees mail that arrives after it is
  // activated. Run this once by hand to process what is already in the label;
  // the same dedupe, labels and upserts make re-running it harmless.
  {
    parameters: {},
    type: "n8n-nodes-base.manualTrigger",
    typeVersion: 1,
    position: [0, 520],
    id: "backfill-trigger",
    name: "Backfill (manual)",
  },
  {
    parameters: {
      resource: "message",
      operation: "getAll",
      returnAll: false,
      limit: 500,
      simple: false,
      filters: { q: JOB_MAIL_QUERY, readStatus: "both", includeSpamTrash: false },
      options: {},
    },
    type: "n8n-nodes-base.gmail",
    typeVersion: 2.2,
    position: [0, 720],
    id: "backfill-fetch",
    name: "Fetch Job Mail",
    credentials: { gmailOAuth2: { id: "REPLACE_ME", name: "Gmail account" } },
  },
  {
    parameters: {
      operation: "removeItemsSeenInPreviousExecutions",
      logic: "removeItemsWithAlreadySeenKeyValues",
      dedupeValue: ex("{{ $json.id }}"),
      options: { scope: "workflow", historySize: 10000 },
    },
    type: "n8n-nodes-base.removeDuplicates",
    typeVersion: 2,
    position: [220, 300],
    id: "dedupe",
    name: "Skip Already Seen",
  },
  {
    parameters: { mode: "runOnceForEachItem", language: "javaScript", jsCode: parserSource },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [440, 300],
    id: "parse",
    name: "Parse Job Email",
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
        conditions: [{
          id: "is-parsed",
          leftValue: ex("{{ $json.parsed }}"),
          rightValue: "",
          operator: { type: "boolean", operation: "true", singleValue: true },
        }],
        combinator: "and",
      },
      options: {},
    },
    type: "n8n-nodes-base.if",
    typeVersion: 2.3,
    position: [660, 300],
    id: "route",
    name: "Classified?",
  },
  airtableNode("Write to Inbox", INBOX_TABLE_ID, INBOX_FIELDS, [900, 180]),
  airtableNode("Write to Needs Review", REVIEW_TABLE_ID, REVIEW_FIELDS, [900, 420]),
  {
    // Airtable's search node runs once per input item, but when a whole batch
    // of items all find zero Feed rows, n8n collapses the output to a single
    // placeholder item and tags it as paired with every item in the batch
    // instead of just one. Merge Into Feed's $('Parse Job Email').item then
    // has multiple equally-valid candidates and throws "Multiple matches" —
    // this bit a real run at 36 emails. Loop Feed Rows forces batch size 1 so
    // Find Feed Row can never see more than one email at a time, which makes
    // the collapse impossible rather than working around its symptom.
    parameters: { batchSize: 1 },
    type: "n8n-nodes-base.splitInBatches",
    typeVersion: 3,
    position: [1120, 180],
    id: "loop-feed-rows",
    name: "Loop Feed Rows",
  },
  {
    parameters: {
      authentication: "airtableTokenApi",
      resource: "record",
      operation: "search",
      base: { __rl: true, mode: "id", value: BASE_ID },
      table: { __rl: true, mode: "id", value: FEED_TABLE_ID },
      // JSON.stringify quotes and escapes the key the way an Airtable formula
      // string literal expects, so a title containing quotes can't break it.
      filterByFormula: ex("{{ '{Application Key} = ' + JSON.stringify($('Parse Job Email').item.json.application_key) }}"),
      returnAll: false,
      limit: 1,
      options: {},
    },
    type: "n8n-nodes-base.airtable",
    typeVersion: 2.1,
    position: [1340, 40],
    id: "find-feed-row",
    name: "Find Feed Row",
    // No match is the normal case for a new application; without this the
    // item disappears and the email never reaches Feed or gets labelled.
    alwaysOutputData: true,
    onError: "continueRegularOutput",
    credentials: { airtableTokenApi: { id: "REPLACE_ME", name: "Airtable account" } },
  },
  {
    parameters: { mode: "runOnceForEachItem", language: "javaScript", jsCode: mergeSource },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [1340, 320],
    id: "merge-feed",
    name: "Merge Into Feed",
  },
  airtableNode("Upsert Feed", FEED_TABLE_ID, FEED_FIELDS, [1600, 180], "Application Key"),
  {
    parameters: {
      resource: "message",
      operation: "addLabels",
      // $json here is the Airtable API response, not the email — the message id
      // has to come from the parser explicitly. This is the single most common
      // way a workflow like this breaks after someone inserts a node.
      messageId: ex("{{ $('Parse Job Email').item.json.message_id }}"),
      // "Job Application" (so keyword-matched mail joins the label) — but
      // only for mail the parser recognised: a newsletter that happened to
      // say "thank you for applying" must not join a label you curate. Every
      // email gets "Job Application/Processed" (so it is never polled again)
      // and the status sub-label the parser chose.
      labelIds: [
        ex(`{{ $('Parse Job Email').item.json.parsed ? ${JSON.stringify(LABELS.scope)} : ${JSON.stringify(LABELS.processed)} }}`),
        LABELS.processed,
        ex(`{{ (${JSON.stringify(LABELS.status)})[$('Parse Job Email').item.json.status_label] || ${JSON.stringify(LABELS.status["Needs Review"])} }}`),
      ],
    },
    type: "n8n-nodes-base.gmail",
    typeVersion: 2.2,
    position: [1800, 300],
    id: "mark-handled",
    name: "Mark Email Processed",
    // Deliberately AFTER both writes: a crash between the two loses a label,
    // not a row. A duplicate-free re-poll is cheap; a silently dropped
    // application email is not.
    onError: "continueRegularOutput",
    credentials: { gmailOAuth2: { id: "REPLACE_ME", name: "Gmail account" } },
  },
  {
    parameters: {
      method: "POST",
      url: "https://api.github.com/repos/shuakyle21/job-tracker-dashboard/dispatches",
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "Accept", value: "application/vnd.github+json" },
          { name: "X-GitHub-Api-Version", value: "2022-11-28" },
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: '{"event_type": "tracker-updated"}',
      options: {},
    },
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.5,
    position: [2020, 300],
    id: "rebuild",
    name: "Trigger Dashboard Rebuild",
    // One rebuild per run, not one per email. Without this, a poll that picks
    // up eight emails fires eight Actions runs that all build the same data.
    executeOnce: true,
    onError: "continueRegularOutput",
  },
];

const stickies = [
  ["## 1. Poll and dedupe\nQuery: mail under **Job Application**, or containing confirmation phrases (\"thank you for applying\", \"received your application\", …), minus **Job Application/Processed**.\n\n**Backfill (manual)**: run once to process mail already in the label.\n\n**Remove Duplicates** is the second net: it catches a re-delivery in the window between the Airtable write and the label being applied.", [-40, 20], 400, 280, 4],
  ["## 2. Classify\nPure function, no network. Source of truth is `n8n/parse-email.js` in the repo — it has tests. Edit it there and re-run `node scripts/build-n8n.mjs`, not here.", [400, 60], 380, 220, 3],
  ["## 3. Store\nInbox / Needs Review rows key on `message_id`, so re-running is an update, not a duplicate.\n\nClassified mail also upserts **Feed**, one row per application (`Application Key` = company|title, or platform|title|thread-id when the employer is unknown). `merge-feed.js` only moves a row forward: earliest date, highest stage, no status regressions — hand edits survive.", [820, 20], 860, 260, 5],
  ["## 4. Close the loop\nLabel is applied **after** the write — a crash loses a label, not a row.\n\nThe rebuild fires once per run and reaches GitHub Actions as a `repository_dispatch`, so the dashboard updates in seconds instead of waiting for the 6-hourly cron.", [1760, 20], 400, 280, 6],
];

for (const [content, position, width, height, color] of stickies) {
  nodes.push({
    parameters: { content, width, height, color },
    type: "n8n-nodes-base.stickyNote",
    typeVersion: 1,
    position,
    id: `sticky-${nodes.length}`,
    name: `Note ${nodes.length}`,
  });
}

const one = (name) => [[{ node: name, type: "main", index: 0 }]];

const workflow = {
  name: "Job Tracker — Gmail ingest",
  nodes,
  connections: {
    "Poll Gmail": { main: one("Skip Already Seen") },
    "Backfill (manual)": { main: one("Fetch Job Mail") },
    "Fetch Job Mail": { main: one("Skip Already Seen") },
    "Skip Already Seen": { main: one("Parse Job Email") },
    "Parse Job Email": { main: one("Classified?") },
    "Classified?": {
      main: [
        [{ node: "Write to Inbox", type: "main", index: 0 }],
        [{ node: "Write to Needs Review", type: "main", index: 0 }],
      ],
    },
    "Write to Inbox": { main: one("Loop Feed Rows") },
    // Output 0 is "done" (every merged row, once the loop finishes) and
    // output 1 is "loop" (the next single email to look up) — Loop Over
    // Items always numbers them in that order.
    "Loop Feed Rows": { main: [one("Upsert Feed")[0], one("Find Feed Row")[0]] },
    "Find Feed Row": { main: one("Merge Into Feed") },
    "Merge Into Feed": { main: one("Loop Feed Rows") },
    "Upsert Feed": { main: one("Mark Email Processed") },
    "Write to Needs Review": { main: one("Mark Email Processed") },
    "Mark Email Processed": { main: one("Trigger Dashboard Rebuild") },
  },
  settings: { executionOrder: "v1", saveManualExecutions: true, saveExecutionProgress: true },
  pinData: {},
  meta: { instanceId: "job-tracker-dashboard" },
  tags: [],
};

const out = join(ROOT, "n8n/job-tracker-ingest.json");
await writeFile(out, JSON.stringify(workflow, null, 2) + "\n");
console.log(`Wrote ${out}`);
console.log(`  ${nodes.length} nodes, parser body ${parserSource.length} chars`);
