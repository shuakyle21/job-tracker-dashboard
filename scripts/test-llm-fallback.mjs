#!/usr/bin/env node
/**
 * Runs n8n/llm-fallback.js outside n8n. Like test-parser.mjs and
 * test-merge-feed.mjs, it wraps the Code node body in a Function with the
 * same free variables n8n provides ($json and $), so what passes here is
 * exactly what runs there.
 *
 *   node scripts/test-llm-fallback.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const source = await readFile(join(ROOT, "n8n/llm-fallback.js"), "utf8");
// eslint-disable-next-line no-new-func
const body = new Function("$json", "$", source);
const apply = (llmResponse, original) => body(llmResponse, () => ({ item: { json: original } })).json;

let failures = 0;
function expect(label, got, want) {
  if (got === want) console.log(`  ok    ${label}`);
  else {
    console.error(`  FAIL  ${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
    failures++;
  }
}

const unparsedRow = (over = {}) => ({
  status: "", status_label: "Needs Review", parsed: false, confidence: "low",
  company: "Acme Robotics", job_title: "Backend Engineer", job_platform: "Company Website",
  application_key: "acme robotics|backend engineer",
  ...over,
});

const chatReply = (content) => ({ choices: [{ message: { content } }] });

console.log("LLM fallback tests\n");

for (const [field, want] of Object.entries({
  status: "interview scheduled", status_label: "Interview", parsed: true, confidence: "medium",
})) {
  const got = apply(chatReply(JSON.stringify({ status: "interview scheduled" })), unparsedRow());
  expect(`valid recognized status → ${field}`, got[field], want);
}

for (const [field, want] of Object.entries(unparsedRow())) {
  const got = apply(chatReply("not json"), unparsedRow());
  expect(`malformed JSON leaves row unchanged → ${field}`, got[field], want);
}

for (const [field, want] of Object.entries(unparsedRow())) {
  const got = apply(chatReply(JSON.stringify({ status: "maybe" })), unparsedRow());
  expect(`unrecognized status leaves row unchanged → ${field}`, got[field], want);
}

for (const [field, want] of Object.entries(unparsedRow())) {
  const got = apply({ error: { message: "upstream timed out" } }, unparsedRow());
  expect(`HTTP-error passthrough leaves row unchanged → ${field}`, got[field], want);
}

{
  const alreadyParsed = unparsedRow({ status: "applied", status_label: "Applied", parsed: true, confidence: "high" });
  for (const [field, want] of Object.entries(alreadyParsed)) {
    const got = apply(chatReply(JSON.stringify({ status: "offer" })), alreadyParsed);
    expect(`already-parsed row is never overridden → ${field}`, got[field], want);
  }
}

{
  // No company means no `company|role` Feed key, so a job board alone is not
  // enough: the email stays at Needs Review, same rule as parse-email.js.
  const boardOnly = unparsedRow({ company: "", job_platform: "Indeed", application_key: "" });
  const got = apply(chatReply(JSON.stringify({ status: "applied" })), boardOnly);
  expect("job-board email without a company stays unparsed", got.parsed, false);
}

{
  const noCompanyNoBoard = unparsedRow({ company: "", application_key: "" });
  const got = apply(chatReply(JSON.stringify({ status: "applied" })), noCompanyNoBoard);
  expect("no company and not a known board stays unparsed", got.parsed, false);
}

console.log(failures ? `\n${failures} check(s) failed\n` : "\nAll LLM fallback checks passed\n");
process.exit(failures ? 1 : 0);
