#!/usr/bin/env node
/**
 * Runs n8n/parse-email.js outside n8n against real email shapes.
 *
 * Why this exists: the parser is the only real logic in the workflow, and the
 * alternative to testing it here is testing it in production, one wrong row at
 * a time. The code-node body reads `$json` and returns `{ json }`, so wrapping
 * it in a Function with `$json` as the single argument runs it exactly as n8n
 * does — no mocking, no n8n needed.
 *
 *   node scripts/test-parser.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const source = await readFile(join(ROOT, "n8n/parse-email.js"), "utf8");
// eslint-disable-next-line no-new-func
const parse = new Function("$json", source);

let failures = 0;
function expect(label, got, want) {
  const ok = got === want;
  if (ok) console.log(`  ok    ${label}`);
  else {
    console.error(`  FAIL  ${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
    failures++;
  }
}

function email(over = {}) {
  return {
    id: "msg-1", threadId: "thr-1", date: "2026-09-15T04:12:00.000Z",
    subject: "", from: { value: [{ address: "x@example.com", name: "" }] },
    text: "", ...over,
  };
}

const cases = [
  {
    name: "LinkedIn application sent",
    input: email({
      subject: "Your application was sent to Acme Robotics",
      from: { value: [{ address: "jobs-noreply@linkedin.com", name: "LinkedIn" }] },
      text: "Your application was submitted to Acme Robotics for Backend Engineer.",
    }),
    want: { status: "applied", source: "LinkedIn", parsed: true, max_stage: 1 },
  },
  {
    name: "LinkedIn viewed by employer",
    input: email({
      subject: "Your application was viewed by Northwind Labs",
      from: { value: [{ address: "jobs-noreply@linkedin.com", name: "LinkedIn" }] },
      text: "Northwind Labs viewed your application for Data Engineer.",
    }),
    want: { status: "viewed by employer", max_stage: 2 },
  },
  {
    // The case that breaks naive classifiers: a rejection that mentions the
    // interview it followed. Status must be the rejection; the funnel must
    // still see stage 4.
    name: "rejection after an interview",
    input: email({
      subject: "Update on your application — Product Engineer at Stride",
      from: { value: [{ address: "careers@stride-site.com", name: "Stride Careers" }] },
      text: "Thank you for interviewing with us last week. Unfortunately we have decided not to move forward.",
    }),
    want: { status: "rejected", max_stage: 4, company: "Stride" },
  },
  {
    name: "rejection after review only",
    input: email({
      subject: "Your application to Yngen Datacom",
      from: { value: [{ address: "hr@yngen.com.ph", name: "Yngen Datacom HR" }] },
      text: "After reviewing your application, unfortunately you were not selected.",
    }),
    want: { status: "rejected", max_stage: 2 },
  },
  {
    name: "interview invitation",
    input: email({
      subject: "Invitation to interview — Full Stack Developer at Q2Q Technologies",
      from: { value: [{ address: "talent@q2q.com", name: "Q2Q Technologies Talent" }] },
      text: "Please pick a time on https://calendly.com/q2q/interview",
    }),
    want: { status: "interview scheduled", max_stage: 4, job_title: "Full Stack Developer", company: "Q2Q Technologies" },
  },
  {
    name: "assessment invitation",
    input: email({
      subject: "Next steps: coding challenge for AI Automation Specialist",
      from: { value: [{ address: "no-reply@greenhouse.io", name: "Access Offshoring Recruiting" }] },
      text: "Please complete the take-home exercise within 72 hours.",
    }),
    // No interview is mentioned, so stage evidence stops at 3. Asserting 4
    // here would be asserting a bug.
    want: { status: "assessment", max_stage: 3 },
  },
  {
    name: "offer",
    input: email({
      subject: "Offer of employment — Backend Engineer",
      from: { value: [{ address: "people@flyrank.ai", name: "FlyRank AI" }] },
      text: "We are pleased to offer you the position. Offer letter attached.",
    }),
    want: { status: "offer", max_stage: 5, company: "FlyRank AI" },
  },
  {
    name: "talent pool",
    input: email({
      subject: "Thank you for your interest in BruntWork",
      from: { value: [{ address: "careers@bruntwork.co", name: "BruntWork Careers" }] },
      text: "We will keep your resume on file for future opportunities.",
    }),
    want: { status: "talent pool", max_stage: 2 },
  },
  {
    // Newsletters, invoices and recruiter spam all land here. The important
    // property is that it does not silently become a tracker row.
    name: "unrelated email goes to needs-review",
    input: email({
      subject: "Your weekly digest",
      from: { value: [{ address: "digest@medium.com", name: "Medium Daily Digest" }] },
      text: "Here are stories we think you will like.",
    }),
    want: { parsed: false, status: "", confidence: "low" },
  },
  {
    name: "known status but unknown company still routes to review",
    input: email({
      subject: "Application received",
      from: { value: [{ address: "no-reply@myworkday.com", name: "no-reply" }] },
      text: "Thank you for applying.",
    }),
    // "Application received" strips to nothing and the Workday domain says
    // nothing about the employer, so neither company nor title survives —
    // low, not medium. The row still reaches needs-review with its subject.
    want: { parsed: false, confidence: "low", status: "applied" },
  },
  {
    name: "date is normalised to ISO",
    input: email({ subject: "Thank you for applying to Portcast", date: "2026-08-03T22:45:10.000Z",
      from: { value: [{ address: "hr@portcast.io", name: "Portcast" }] } }),
    want: { received_at: "2026-08-03" },
  },
  {
    name: "epoch-millisecond internalDate is handled",
    input: email({ subject: "Thank you for applying to Portcast", date: undefined,
      internalDate: 1754260000000,
      from: { value: [{ address: "hr@portcast.io", name: "Portcast" }] } }),
    want: { received_at: "2025-08-03" },
  },
];

console.log("Parser tests\n");
for (const c of cases) {
  const got = parse(c.input).json;
  for (const [field, want] of Object.entries(c.want)) {
    expect(`${c.name} → ${field}`, got[field], want);
  }
}

// The parser must never throw, whatever Gmail hands it. A missing field is a
// needs-review row, not a failed execution that strands the email unlabelled.
console.log("\nRobustness");
for (const junk of [{}, { subject: null }, { from: {} }, { date: "not a date" }, { text: 12345 }]) {
  let threw = null;
  let out = null;
  try { out = parse({ id: "x", ...junk }).json; } catch (e) { threw = e; }
  expect(`survives ${JSON.stringify(junk)}`, threw === null && typeof out === "object", true);
}

console.log(failures ? `\n${failures} check(s) failed\n` : "\nAll parser checks passed\n");
process.exit(failures ? 1 : 0);
