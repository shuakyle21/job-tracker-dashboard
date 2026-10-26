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
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`  ok    ${label}`);
  else {
    console.error(`  FAIL  ${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
    failures++;
  }
}

const unparsedRow = (over = {}) => ({
  status: "", status_label: "Needs Review", parsed: false, confidence: "low",
  company: "Acme Robotics", job_title: "Backend Engineer", job_platform: "Company Website",
  application_key: "acme robotics|backend engineer",
  subject: "Your application was sent to Acme Robotics",
  raw_text: "Your application for Backend Engineer was sent to Acme Robotics.",
  max_stage: 1,
  ...over,
});

// The Message an Agent node: structuredOutput is the schema-matched object,
// null when the agent ignored the output format; its JSON is then in text.
const agentReply = (structuredOutput, text = "") => ({ structuredOutput, text });
// The repo-generated HTTP node's OpenAI shape.
const chatReply = (content) => ({ choices: [{ message: { content } }] });

console.log("LLM fallback tests\n");

for (const [field, want] of Object.entries({
  status: "interview scheduled", status_label: "Interview", parsed: true, confidence: "medium",
})) {
  const got = apply(agentReply({ status: "interview scheduled", company: null, job_title: null, max_stage: 1 }), unparsedRow());
  expect(`structuredOutput status → ${field}`, got[field], want);
}

for (const [field, want] of Object.entries({
  status: "offer", status_label: "Offer", parsed: true, confidence: "medium",
})) {
  const got = apply(agentReply(null, JSON.stringify({ status: "offer" })), unparsedRow());
  expect(`structuredOutput null, JSON in text → ${field}`, got[field], want);
}

{
  const got = apply(chatReply(JSON.stringify({ status: "assessment" })), unparsedRow());
  expect("OpenAI choices shape still works → status", got.status, "assessment");
  expect("OpenAI choices shape still works → parsed", got.parsed, true);
}

for (const [field, want] of Object.entries(unparsedRow())) {
  const got = apply(agentReply(null, "not json"), unparsedRow());
  expect(`malformed text leaves row unchanged → ${field}`, got[field], want);
}

for (const [field, want] of Object.entries(unparsedRow())) {
  const got = apply(agentReply({ status: "maybe", company: null, job_title: null, max_stage: 1 }), unparsedRow());
  expect(`unrecognized status leaves row unchanged → ${field}`, got[field], want);
}

// The classifier Agent answers status:null for job alerts and newsletters,
// even when it names a company. That must stay in Needs Review.
for (const [field, want] of Object.entries(unparsedRow())) {
  const got = apply(agentReply({ status: null, company: "Acme Robotics", job_title: null, max_stage: 1 }), unparsedRow());
  expect(`null status leaves row unchanged → ${field}`, got[field], want);
}

for (const [field, want] of Object.entries(unparsedRow())) {
  const got = apply({ error: { message: "agent timed out" } }, unparsedRow());
  expect(`error passthrough leaves row unchanged → ${field}`, got[field], want);
}

{
  const alreadyParsed = unparsedRow({ status: "applied", status_label: "Applied", parsed: true, confidence: "high" });
  for (const [field, want] of Object.entries(alreadyParsed)) {
    const got = apply(agentReply({ status: "offer", company: "Other Co", job_title: null, max_stage: 5 }), alreadyParsed);
    expect(`already-parsed row is never overridden → ${field}`, got[field], want);
  }
}

{
  // The common Needs Review case: the rule parser had the title but not the
  // employer, so it could not build a key. The agent supplies the employer
  // named in the email and the key becomes complete.
  const row = unparsedRow({ company: "", application_key: "" });
  const got = apply(agentReply({ status: "applied", company: "Acme Robotics", job_title: null, max_stage: 1 }), row);
  expect("agent fills a company named in the email → key", got.application_key, "acme robotics|backend engineer");
  expect("agent fills a company named in the email → parsed", got.parsed, true);
  expect("agent fills a company named in the email → confidence", got.confidence, "medium");
}

{
  const row = unparsedRow({
    company: "", application_key: "",
    subject: "Update on your application", raw_text: "We have received your application.",
  });
  const got = apply(agentReply({ status: "applied", company: "Globex", job_title: null, max_stage: 1 }), row);
  expect("invented company is rejected → key stays empty", got.application_key, "");
  expect("invented company is rejected → stays unparsed", got.parsed, false);
}

{
  const row = unparsedRow({
    company: "", application_key: "",
    subject: "Application sent", raw_text: "Your application was sent via LinkedIn.",
  });
  const got = apply(agentReply({ status: "applied", company: "LinkedIn", job_title: null, max_stage: 1 }), row);
  expect("job board as company is rejected → key stays empty", got.application_key, "");
  expect("job board as company is rejected → stays unparsed", got.parsed, false);
}

{
  const row = unparsedRow({
    company: "", application_key: "",
    subject: "Indeed Application: Backend Engineer", raw_text: "Indeed Apply\nYour application for Backend Engineer was submitted.",
  });
  const got = apply(chatReply(JSON.stringify({ status: "applied", company: "Indeed Apply" })), row);
  expect("board display name as company is rejected → stays unparsed", got.parsed, false);
}

{
  // The generated HTTP node's reply shape, on the company-fill path.
  const row = unparsedRow({ company: "", application_key: "" });
  const got = apply(chatReply(JSON.stringify({ status: "applied", company: "acme robotics" })), row);
  expect("OpenAI shape fills company in the email's spelling → company", got.company, "Acme Robotics");
  expect("OpenAI shape fills company → key", got.application_key, "acme robotics|backend engineer");
  expect("OpenAI shape fills company → parsed", got.parsed, true);
}

{
  const got = apply(agentReply({ status: "applied", company: null, job_title: null, max_stage: 4 }), unparsedRow());
  expect("model's max_stage can't exceed its status's stage", got.max_stage, 1);
}

{
  const got = apply(agentReply({ status: "in review", company: null, job_title: null, max_stage: 2 }), unparsedRow({ max_stage: 4 }));
  expect("max_stage never regresses", got.max_stage, 4);
}

{
  const got = apply(chatReply(JSON.stringify({ status: "offer" })), unparsedRow());
  expect("status alone credits its stage (offer → 5)", got.max_stage, 5);
}

{
  // No company means no `company|role` Feed key, so a job board alone is not
  // enough: the email stays at Needs Review, same rule as parse-email.js.
  const boardOnly = unparsedRow({ company: "", job_platform: "Indeed", application_key: "" });
  const got = apply(agentReply({ status: "applied", company: null, job_title: null, max_stage: 1 }), boardOnly);
  expect("job-board email without a company stays unparsed", got.parsed, false);
}

console.log(failures ? `\n${failures} check(s) failed\n` : "\nAll LLM fallback checks passed\n");
process.exit(failures ? 1 : 0);
