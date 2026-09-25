#!/usr/bin/env node
/**
 * Runs n8n/merge-feed.js outside n8n. Like test-parser.mjs, it wraps the Code
 * node body in a Function with the same free variables n8n provides ($json and
 * $), so what passes here is exactly what runs there.
 *
 *   node scripts/test-merge-feed.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const source = await readFile(join(ROOT, "n8n/merge-feed.js"), "utf8");
// eslint-disable-next-line no-new-func
const body = new Function("$json", "$", source);
const merge = (row, email) => body(row, () => ({ item: { json: email } })).json;

let failures = 0;
function expect(label, got, want) {
  if (got === want) console.log(`  ok    ${label}`);
  else {
    console.error(`  FAIL  ${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
    failures++;
  }
}

const email = (over = {}) => ({
  application_key: "acme|backend engineer", job_title: "Backend Engineer", company: "Acme",
  job_platform: "JobStreet", status: "applied", max_stage: 1, received_at: "2026-09-10", ...over,
});

const cases = [
  {
    name: "no existing row creates one",
    row: {},
    email: email(),
    want: { "Status": "Applied", "Job Platform": "JobStreet", "Source": "Jobstreet",
      "Date Applied": "2026-09-10", "Max Stage": 1, "Job Role": "Backend Engineer" },
  },
  {
    name: "later viewed email advances status and stage, keeps the date",
    row: { "Status": "Applied", "Date Applied": "2026-09-10", "Max Stage": 1, "Job Platform": "JobStreet" },
    email: email({ status: "viewed by employer", max_stage: 2, received_at: "2026-09-14" }),
    want: { "Status": "Viewed by Employer", "Date Applied": "2026-09-10", "Max Stage": 2 },
  },
  {
    // Emails can be processed out of order (backfill, re-poll). A confirmation
    // arriving after the interview must not undo it.
    name: "late confirmation does not regress status",
    row: { "Status": "Interviewed", "Date Applied": "2026-09-12", "Max Stage": 4 },
    email: email({ status: "applied", max_stage: 1, received_at: "2026-09-10" }),
    want: { "Status": "Interviewed", "Max Stage": 4, "Date Applied": "2026-09-10" },
  },
  {
    name: "rejection after interview wins, stage is kept",
    row: { "Status": "Interviewed", "Max Stage": 4 },
    email: email({ status: "rejected", max_stage: 4 }),
    want: { "Status": "Rejected", "Max Stage": 4 },
  },
  {
    name: "hand-edited fields are preserved",
    row: { "Source": "Direct / Workable", "Job Platform": "Company Website", "Company": "Acme Corp" },
    email: email({ job_platform: "LinkedIn", company: "Acme" }),
    want: { "Source": "Direct / Workable", "Job Platform": "Company Website", "Company": "Acme Corp" },
  },
  {
    name: "Airtable search shape with nested fields",
    row: { id: "rec1", fields: { "Status": "Offer", "Max Stage": 5 } },
    email: email({ status: "rejected" }),
    want: { "Status": "Offer", "Max Stage": 5 },
  },
  {
    name: "unknown status keeps the existing one",
    row: { "Status": "In Review" },
    email: email({ status: "" }),
    want: { "Status": "In Review" },
  },
  {
    // Real duplicate: the hand-typed key has spaces around "|". Find Feed Row
    // ignores that spacing, but the upsert matches Application Key exactly —
    // writing the email's own key would create a second row next to this one.
    name: "found row keeps its own key so the upsert updates it",
    row: { id: "rec1", fields: { "Application Key": "va masters | developer & automation expert", "Status": "In Review" } },
    email: email({ application_key: "va masters|developer & automation expert", status: "viewed by employer", max_stage: 2 }),
    want: { "Application Key": "va masters | developer & automation expert", "Status": "Viewed by Employer", "Max Stage": 2 },
  },
  {
    name: "no existing row writes the email's key",
    row: {},
    email: email(),
    want: { "Application Key": "acme|backend engineer" },
  },
];

console.log("Feed merge tests\n");
for (const c of cases) {
  const got = merge(c.row, c.email);
  for (const [field, want] of Object.entries(c.want)) expect(`${c.name} → ${field}`, got[field], want);
}

// Only parsed emails reach Feed, and the parser only parses an email with a
// company and a title. A key that breaks that means a bug upstream: stop the
// execution loudly rather than write a row no later email can match.
console.log("\nMalformed keys stop the write");
for (const key of ["", "|backend engineer", "acme|", "acme | backend engineer", " acme|backend engineer", "acme"]) {
  let threw = false;
  try { merge({}, email({ application_key: key })); } catch { threw = true; }
  expect(`throws on ${JSON.stringify(key)}`, threw, true);
}
let threwOnMissingCompany = false;
try { merge({}, email({ company: "" })); } catch { threwOnMissingCompany = true; }
expect("throws on an empty company", threwOnMissingCompany, true);

console.log(failures ? `\n${failures} check(s) failed\n` : "\nAll merge checks passed\n");
process.exit(failures ? 1 : 0);
