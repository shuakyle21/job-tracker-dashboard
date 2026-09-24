#!/usr/bin/env node
/**
 * Runs scripts/check-live.mjs's comparison logic against the generated
 * workflows and mutated copies of them — no n8n instance, no network. The
 * mutations are the drift that actually happened on the live instance.
 *
 *   node scripts/test-check-live.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { diffWorkflows, findSharedCredentials, recentErrors, runningVersion } from "./check-live.mjs";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const ingest = JSON.parse(await readFile(join(ROOT, "n8n/job-tracker-ingest.json"), "utf8"));
const sync = JSON.parse(await readFile(join(ROOT, "n8n/job-tracker-feed-sync.json"), "utf8"));

let failures = 0;
function expect(label, ok, detail = "") {
  if (ok) console.log(`  ok    ${label}`);
  else { console.error(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); failures++; }
}

const copy = (wf) => structuredClone(wf);
const node = (wf, name) => wf.nodes.find((n) => n.name === name);

// What the instance does to a workflow on import that isn't drift.
function asImported(wf) {
  const live = copy(wf);
  live.nodes.forEach((n, i) => {
    n.id = `live-${i}`;
    n.position = [n.position[0] + 7, n.position[1] + 3];
    for (const c of Object.values(n.credentials ?? {})) { c.id = `cred-${n.name}`; c.name = "Renamed in the UI"; }
    n.parameters = { ...n.parameters, emptyDefault: {}, nullDefault: null };
    if (n.type === "n8n-nodes-base.stickyNote") n.parameters.width += 40;
  });
  return live;
}

console.log("check-live comparison tests\n");

for (const wf of [ingest, sync]) {
  const got = diffWorkflows(wf, asImported(wf));
  expect(`${wf.name}: a clean import is not drift`, got.length === 0, got.join("; "));
}

{
  const live = asImported(ingest);
  node(live, "Poll Gmail").parameters.filters.labelIds = ["Label_14", "Label_1523943501121152783", "INBOX"];
  const got = diffWorkflows(ingest, live);
  expect("extra Gmail labelIds filter is caught", got.some((p) => p.includes("Poll Gmail") && p.includes("labelIds")), got.join("; "));
}

{
  const live = asImported(ingest);
  node(live, "Mark Email Processed").parameters.labelIds = ["Label_14"];
  const got = diffWorkflows(ingest, live);
  expect("narrowed labels are caught", got.some((p) => p.includes("Mark Email Processed")), got.join("; "));
}

{
  const live = asImported(ingest);
  live.nodes.push({ name: "Poll Feed For Hand Edits", type: "n8n-nodes-base.airtableTrigger", typeVersion: 1, parameters: {}, position: [0, 0] });
  const got = diffWorkflows(ingest, live);
  expect("a node added by hand is caught", got.some((p) => p.includes("Poll Feed For Hand Edits")), got.join("; "));
}

{
  const live = asImported(ingest);
  for (const n of live.nodes) n.name = n.type === "n8n-nodes-base.stickyNote" ? n.name : `${n.name}1`;
  const got = diffWorkflows(ingest, live);
  expect("renamed nodes are caught", got.some((p) => p.includes('"Poll Gmail" is missing')), got.slice(0, 2).join("; "));
}

{
  const live = asImported(ingest);
  delete live.connections["Upsert Feed"];
  const got = diffWorkflows(ingest, live);
  expect("a dropped connection is caught", got.some((p) => p.startsWith("connection missing: Upsert Feed")), got.join("; "));
}

{
  const live = asImported(ingest);
  node(live, "Classify With LLM").parameters.genericAuthType = "httpHeaderAuth";
  node(live, "Classify With LLM").credentials = { httpHeaderAuth: { id: "x", name: "Header Auth account" } };
  const got = diffWorkflows(ingest, live);
  expect("LLM credential type drift is caught", got.some((p) => p.includes("Classify With LLM")), got.join("; "));
}

{
  const live = asImported(ingest);
  node(live, "Write to Inbox").disabled = true;
  const got = diffWorkflows(ingest, live);
  expect("a disabled node is caught", got.some((p) => p.includes("Write to Inbox")), got.join("; "));
}

{
  const liveSync = asImported(sync);
  const liveIngest = asImported(ingest);
  const shared = { id: "HQ1RrQMKPAQGKgE9", name: "Header Auth account" };
  node(liveSync, "Trigger Dashboard Rebuild").credentials = { httpHeaderAuth: shared };
  node(liveIngest, "Classify With LLM").credentials = { httpHeaderAuth: shared };
  const got = findSharedCredentials([liveSync, liveIngest]);
  expect("GitHub credential shared with the LLM node is caught", got.some((p) => p.includes("Classify With LLM")), got.join("; "));
  expect("separate credentials pass", findSharedCredentials([asImported(sync), asImported(ingest)]).length === 0);
}

{
  const live = asImported(ingest);
  node(live, "Write to Inbox").onError = "continueRegularOutput";
  node(live, "Parse Job Email").onError = "stopWorkflow";
  Object.assign(node(live, "Parse Job Email"), { maxTries: 3, waitBetweenTries: 1000 });
  const got = diffWorkflows(ingest, live);
  expect("explicit n8n defaults are not drift", got.length === 0, got.join("; "));
}

{
  const live = asImported(ingest);
  node(live, "Parse Job Email").onError = "continueRegularOutput";
  const got = diffWorkflows(ingest, live);
  expect("a real onError change is drift", got.some((p) => p.includes("Parse Job Email")), got.join("; "));
}

{
  // The Feed Manual Edit case: the draft is clean, the published version isn't.
  const published = asImported(ingest);
  published.nodes.push({ name: "Poll Feed For Hand Edits", type: "n8n-nodes-base.airtableTrigger", typeVersion: 1, parameters: {}, position: [0, 0] });
  const fetched = { ...asImported(ingest), versionId: "draft-2", activeVersionId: "pub-1",
    activeVersion: { nodes: published.nodes, connections: published.connections } };
  const { running, problems } = runningVersion(fetched);
  expect("an unpublished draft is reported", problems.length === 1, problems.join("; "));
  expect("the published version is what gets compared",
    diffWorkflows(ingest, running).some((p) => p.includes("Poll Feed For Hand Edits")));
  const clean = runningVersion({ ...asImported(ingest), versionId: "v1", activeVersionId: "v1" });
  expect("a published draft is not reported", clean.problems.length === 0 && clean.running.nodes.length === ingest.nodes.length);
}

{
  const now = Date.parse("2026-09-24T12:00:00Z");
  const executions = [
    { id: "1", status: "error", stoppedAt: "2026-09-24T11:30:00Z" },
    { id: "2", status: "error", stoppedAt: "2026-09-24T09:00:00Z" },
    { id: "3", status: "error", startedAt: null, stoppedAt: "2026-09-24T11:59:00Z" },
    { id: "4", status: "success", stoppedAt: "2026-09-24T11:59:00Z" },
  ];
  const got = recentErrors(executions, now, 75 * 60e3).map((e) => e.id);
  expect("recent errors inside the window only", JSON.stringify(got) === '["1","3"]', JSON.stringify(got));
}

console.log(failures ? `\n${failures} check(s) failed\n` : "\nAll check-live comparison checks passed\n");
process.exit(failures ? 1 : 0);
