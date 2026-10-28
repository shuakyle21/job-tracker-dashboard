#!/usr/bin/env node
/**
 * Runs n8n/error-alert.js outside n8n, with the free variables n8n provides
 * ($input, $getWorkflowStaticData), so what passes here is what runs there.
 *
 *   node scripts/test-error-alert.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const source = await readFile(join(ROOT, "n8n/error-alert.js"), "utf8");

let failures = 0;
function expect(label, ok) {
  if (ok) console.log(`  ok    ${label}`);
  else { console.error(`  FAIL  ${label}`); failures++; }
}

// One static-data object per "instance", shared across runs like n8n's.
function alerter(store = {}) {
  return (payload) => new Function("$input", "$getWorkflowStaticData", source)(
    { first: () => ({ json: payload }) }, () => store,
  );
}
const wf = { id: "2Zb8P79JlWTDTmKe", name: "Job Tracker — Gmail ingest" };
const execErr = (message, node = "Mark Email Processed") => ({
  workflow: wf,
  execution: { id: "2300", url: "https://n8n.example/workflow/x/executions/2300", lastNodeExecuted: node, error: { message } },
});

console.log("Error alert tests\n");

{
  const [item] = alerter()(execErr("Airtable 503"));
  const t = item.json.text;
  expect("execution error names workflow, node and link",
    t.includes(wf.name) && t.includes("Mark Email Processed") && t.includes("/executions/2300") && t.includes("ERROR"));
}
{
  const [item] = alerter()({ workflow: wf, trigger: { error: { message: "Quota exceeded for quota metric 'Total Query Cost'", node: { name: "Poll Gmail" } } } });
  expect("trigger-only error uses the trigger node", item.json.text.includes("Node: Poll Gmail"));
  expect("quota is tagged QUOTA", item.json.text.includes("QUOTA"));
}
for (const m of ["The credential 'Gmail account' needs to be reconnected", "401 - Requires authentication"]) {
  const [item] = alerter()(execErr(m));
  expect(`credential tag: ${m.slice(0, 30)}`, item.json.text.includes("CREDENTIAL"));
}
{
  const realNow = Date.now;
  const send = alerter();
  expect("first occurrence alerts", send(execErr("Job mail older than 2h, message 123")).length === 1);
  expect("same error (digits differ) within 6h is silent", send(execErr("Job mail older than 2h, message 456")).length === 0);
  expect("a different error still alerts", send(execErr("Something else")).length === 1);
  Date.now = () => realNow() + 6 * 3600e3 + 1;
  expect("persisting error re-alerts after 6h", send(execErr("Job mail older than 2h, message 789")).length === 1);
  Date.now = realNow;
}

console.log(failures ? `\n${failures} failure(s)` : "\nAll error alert tests passed");
process.exit(failures ? 1 : 0);
