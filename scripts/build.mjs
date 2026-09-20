#!/usr/bin/env node
/**
 * Build the job-search analytics dashboard from the Airtable "Feed" table.
 *
 * Reads : AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME (default "Feed")
 *         — or FEED_FIXTURE, a local Airtable list-records JSON file, for
 *         development and CI, where no live Airtable credentials exist.
 * Writes: dist/index.html  standalone page for GitHub Pages
 *         dist/artifact.html  same body, no <html>/<head> skeleton, for publishing
 *                             as a Claude artifact (the host supplies the skeleton)
 *         data/summary.json aggregate counts only, committed each run
 *
 * Every metric on the dashboard is derived from the nine feed fields and nothing
 * else. If a number cannot be computed from the n8n output, it does not appear.
 *
 * Design rule: nothing identifying reaches dist/ or data/. The Feed table carries
 * no company names, job titles, contacts, links, notes or salary.
 *
 * Zero dependencies. Node 20+.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

// Displayed sync timestamp only — day-boundary math (aggregate()'s `midnight`)
// stays UTC so ageing/day-count buckets don't shift with the server's locale.
function formatPHT(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} PHT`;
}

/* ================================================================== *
 * 1. Fetch
 * ================================================================== */

/**
 * Maps Airtable field names (the "Feed" table, human-maintained) to the
 * snake_case keys aggregate() reads. Keeping the Airtable side friendly for a
 * human editing the base, and the internal side stable so nothing downstream
 * of fetchFeedRecords() has to change.
 */
const FIELD_MAP = {
  "Date Applied": "date_applied",
  "Source": "source",
  "Work Setup": "work_setup",
  "Status": "status",
  "Resume": "resume",
  "Cover Letter": "cover_letter",
  "Tailored": "tailored",
  "Next Follow Up": "next_follow_up",
  "Max Stage": "max_stage",
};

async function fetchFeedRecords() {
  // Local fixture instead of a live call, for development and for the
  // verify.mjs gate, which must pass with no Airtable credentials in the
  // sandbox:
  //   FEED_FIXTURE=./sample-feed.json node scripts/build.mjs
  const fixture = process.env.FEED_FIXTURE;
  if (fixture) {
    const raw = await readFile(fixture, "utf8");
    return JSON.parse(raw).records;
  }

  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE_NAME || "Feed";

  if (!apiKey || !baseId) {
    throw new Error(
      "AIRTABLE_API_KEY / AIRTABLE_BASE_ID are not set, and FEED_FIXTURE is not set either.\n" +
      "For a fixture build: FEED_FIXTURE=./sample-feed.json node scripts/build.mjs\n" +
      "For a real build: set AIRTABLE_API_KEY and AIRTABLE_BASE_ID (AIRTABLE_TABLE_NAME\n" +
      "defaults to \"Feed\") as repo secrets. See README step 3."
    );
  }

  // Airtable paginates at 100 records per page; keep following `offset`
  // until the response omits it.
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) {
      throw new Error(`Airtable fetch failed: ${res.status} ${res.statusText} (table "${table}")`);
    }
    const body = await res.json();
    records.push(...body.records);
    offset = body.offset;
  } while (offset);

  return records;
}

/* ================================================================== *
 * 2. Parse
 * ================================================================== */

function toRecords(airtableRecords) {
  return airtableRecords.map((rec) => {
    const out = {};
    for (const [airtableField, key] of Object.entries(FIELD_MAP)) {
      const v = rec.fields[airtableField];
      out[key] = v === undefined || v === null ? "" : String(v);
    }
    return out;
  });
}

/* ================================================================== *
 * 3. Domain model
 * ================================================================== */

const STAGE_LABELS = ["Applied", "Employer replied", "Assessment", "Interview", "Offer"];

const DROP_PHRASE = [
  "never got past the application",
  "stalled after the employer replied",
  "stalled at the assessment",
  "ended at the interview",
  "ended at offer",
];

/**
 * Furthest stage a status implies, 1-indexed. "Rejected" is the honest problem:
 * it says the application ended, not how deep it got. A `max_stage` column in the
 * Sheet overrides this per row — see stageOf().
 */
const STAGE_OF_STATUS = {
  "draft / to apply": 1,
  "materials ready — verify": 1,
  "applied": 1,
  "no response": 1,
  "closed / expired": 1,
  "rejected": 1,
  "viewed by employer": 2,
  "in review": 2,
  "talent pool": 2,
  "assessment": 3,
  "interview scheduled": 4,
  "interviewed": 4,
  "offer": 5,
};

/**
 * Rows that were never submitted. Excluded from every rate — nobody can answer an
 * application you did not send, and counting them either way makes the rate a lie.
 */
const UNSENT_STATUSES = new Set(["draft / to apply", "materials ready — verify"]);

/** A reply is anything other than silence. A rejection counts: it closes the loop. */
const NO_REPLY_STATUSES = new Set(["applied", "no response", "closed / expired"]);

/** Terminal states. Used only for "still open", never for a rate. */
const DEAD_STATUSES = new Set([
  "rejected", "closed / expired", "withdrawn", "no response", "talent pool",
]);

function stageOf(rec) {
  const explicit = parseInt(rec.max_stage, 10);
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 5) return explicit;
  return STAGE_OF_STATUS[rec.status?.toLowerCase()] ?? 1;
}

const isYes = (v) => /^(yes|true|y|✓|1)$/i.test(v ?? "");
const daysBetween = (a, b) => Math.floor((b - a) / 86400000);

function aggregate(records, today = new Date()) {
  const midnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const total = records.length;

  const lc = (r) => (r.status || "").toLowerCase();

  // --- headline counts ---------------------------------------------
  const unsent  = records.filter(r => UNSENT_STATUSES.has(lc(r))).length;
  const sent    = total - unsent;
  const noReply = records.filter(r => NO_REPLY_STATUSES.has(lc(r))).length;
  const replied = sent - noReply;
  const open    = records.filter(r => !DEAD_STATUSES.has(lc(r)) && !UNSENT_STATUSES.has(lc(r))).length;

  // --- status distribution -----------------------------------------
  const statusMap = new Map();
  for (const r of records) {
    const s = r.status || "(blank)";
    statusMap.set(s, (statusMap.get(s) ?? 0) + 1);
  }
  const byStatus = [...statusMap.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  // --- furthest stage reached --------------------------------------
  const atStage = [0, 0, 0, 0, 0];
  for (const r of records) atStage[stageOf(r) - 1]++;

  const reached = [0, 0, 0, 0, 0];
  let running = 0;
  for (let i = 4; i >= 0; i--) { running += atStage[i]; reached[i] = running; }

  // Bucket drop-off composition by the SAME stageOf() the ribbons use. Bucketing by
  // status alone puts max_stage-overridden rows in the wrong bucket, and then the
  // label stops adding up to the ribbon above it.
  const compMaps = [new Map(), new Map(), new Map(), new Map(), new Map()];
  for (const r of records) {
    const m = compMaps[stageOf(r) - 1];
    const s = r.status || "(blank)";
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  const dropComposition = compMaps.map(m =>
    [...m.entries()].map(([status, count]) => ({ status, count }))
                    .sort((a, b) => b.count - a.count)
  );

  // --- channels ----------------------------------------------------
  const chanMap = new Map();
  for (const r of records) {
    const name = r.source || "(blank)";
    const e = chanMap.get(name) ?? { sent: 0, replied: 0, unsent: 0 };
    if (UNSENT_STATUSES.has(lc(r))) e.unsent++;
    else { e.sent++; if (!NO_REPLY_STATUSES.has(lc(r))) e.replied++; }
    chanMap.set(name, e);
  }
  const channels = [...chanMap.entries()]
    .map(([name, v]) => ({ name, ...v, rate: v.sent ? v.replied / v.sent : null }))
    .sort((a, b) => b.sent - a.sent || b.unsent - a.unsent);

  // --- monthly volume ----------------------------------------------
  const monthMap = new Map();
  for (const r of records) {
    const m = (r.date_applied || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m)) monthMap.set(m, (monthMap.get(m) ?? 0) + 1);
  }
  const monthly = [...monthMap.entries()].sort().map(([month, count]) => ({ month, count }));

  // --- work setup --------------------------------------------------
  // Free-text in the Sheet, so normalise to four buckets rather than rendering
  // twelve near-duplicate slices.
  const setupOf = (v) => {
    const s = (v || "").toLowerCase();
    if (!s) return "Unspecified";
    if (s.includes("hybrid")) return "Hybrid";
    if (s.includes("remote") || s.includes("wfh")) return "Remote";
    if (s.includes("onsite") || s.includes("on-site")) return "Onsite";
    return "Unspecified";
  };
  const setupMap = new Map();
  for (const r of records) {
    const k = setupOf(r.work_setup);
    setupMap.set(k, (setupMap.get(k) ?? 0) + 1);
  }
  const workSetup = ["Remote", "Hybrid", "Onsite", "Unspecified"]
    .filter(k => setupMap.has(k))
    .map(k => ({ label: k, count: setupMap.get(k) }));

  // --- ageing of still-open applications ---------------------------
  const AGE_BUCKETS = [
    { label: "0–7d",  min: 0,  max: 7 },
    { label: "8–14d", min: 8,  max: 14 },
    { label: "15–30d", min: 15, max: 30 },
    { label: "31–60d", min: 31, max: 60 },
    { label: "60d+",  min: 61, max: Infinity },
  ];
  const ageing = AGE_BUCKETS.map(b => ({ label: b.label, count: 0 }));
  for (const r of records) {
    if (DEAD_STATUSES.has(lc(r)) || UNSENT_STATUSES.has(lc(r))) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date_applied || "")) continue;
    const d = daysBetween(new Date(r.date_applied + "T00:00:00Z"), midnight);
    const i = AGE_BUCKETS.findIndex(b => d >= b.min && d <= b.max);
    if (i >= 0) ageing[i].count++;
  }

  // --- follow-ups --------------------------------------------------
  let overdue = 0, dueToday = 0, dueWeek = 0;
  for (const r of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.next_follow_up || "")) continue;
    const d = daysBetween(midnight, new Date(r.next_follow_up + "T00:00:00Z"));
    if (d < 0) overdue++;
    else if (d === 0) dueToday++;
    else if (d <= 7) dueWeek++;
  }

  // --- application quality ------------------------------------------
  const quality = {
    resume:   records.filter(r => isYes(r.resume)).length,
    cover:    records.filter(r => isYes(r.cover_letter)).length,
    tailored: records.filter(r => isYes(r.tailored)).length,
  };

  const usedExplicitStage = records.some(r => {
    const n = parseInt(r.max_stage, 10);
    return Number.isInteger(n) && n >= 1 && n <= 5;
  });

  return {
    generatedAt: new Date().toISOString(),
    total, sent, unsent, replied, noReply, open,
    replyRate:     sent ? replied / sent : null,
    interviewRate: sent ? reached[3] / sent : null,
    ghostRate:     sent ? noReply / sent : null,
    reached, atStage, dropComposition, usedExplicitStage,
    byStatus, channels, monthly, workSetup, ageing,
    followUps: { overdue, dueToday, dueWeek },
    quality,
  };
}

/* ================================================================== *
 * 4. Sankey layout (ApexCharts has no Sankey type, so this is hand-drawn)
 * ================================================================== */

function sankeySVG(agg) {
  const { reached, dropComposition } = agg;
  const PAD_TOP = 30, NODE_W = 12, W = 1000;
  const K = reached[0] > 0 ? 300 / reached[0] : 0;
  const xs = [40, 268, 496, 700, 880];
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const h = (n) => n * K;
  const out = [];

  for (let i = 0; i < 4; i++) {
    const carry = reached[i + 1];
    if (carry <= 0) continue;
    const x1 = xs[i] + NODE_W, x2 = xs[i + 1];
    out.push(`<path class="sk-flow" d="M${x1} ${PAD_TOP} L${x2} ${PAD_TOP} L${x2} ${(PAD_TOP + h(carry)).toFixed(1)} L${x1} ${(PAD_TOP + h(carry)).toFixed(1)} Z"/>`);
  }

  const stubs = [];
  for (let i = 0; i < 5; i++) {
    const drop = reached[i] - (reached[i + 1] ?? 0);
    if (drop <= 0) continue;
    const x1 = xs[i] + NODE_W;
    const x2 = x1 + (i === 0 ? 98 : 100);
    const srcTop = PAD_TOP + h(reached[i + 1] ?? 0);
    const srcBot = PAD_TOP + h(reached[i]);
    const dy = [50, 132, 140, 120, 120][i];
    const dstTop = srcTop + dy, dstBot = dstTop + h(drop);
    const mx = (x1 + x2) / 2;
    out.push(
      `<path class="sk-loss" d="M${x1} ${srcTop.toFixed(1)} ` +
      `C${mx} ${srcTop.toFixed(1)}, ${mx} ${dstTop.toFixed(1)}, ${x2} ${dstTop.toFixed(1)} ` +
      `L${x2} ${dstBot.toFixed(1)} C${mx} ${dstBot.toFixed(1)}, ${mx} ${srcBot.toFixed(1)}, ${x1} ${srcBot.toFixed(1)} Z"/>`
    );
    stubs.push({ i, x: x2, y: dstTop, hh: h(drop), drop });
  }

  for (let i = 0; i < 5; i++) {
    const hh = h(reached[i]);
    out.push(reached[i] > 0
      ? `<rect class="sk-node" x="${xs[i]}" y="${PAD_TOP}" width="${NODE_W}" height="${hh.toFixed(1)}" rx="2"/>`
      : `<rect class="sk-empty" x="${xs[i]}" y="${PAD_TOP - 2}" width="${NODE_W}" height="18" rx="2"/>`);
    out.push(`<text class="sk-num" x="${xs[i]}" y="20">${reached[i]}</text>`);
    out.push(`<text class="sk-lab" x="${xs[i] + String(reached[i]).length * 9 + 12}" y="20">${esc(STAGE_LABELS[i])}</text>`);
  }

  // Track the lowest drawn pixel so the viewBox hugs the content. A fixed height
  // leaves a dead band inside the card whenever the flow is shallow.
  let maxY = PAD_TOP + h(reached[0]);

  for (const s of stubs) {
    out.push(`<rect class="sk-node-loss" x="${s.x}" y="${s.y.toFixed(1)}" width="${NODE_W}" height="${s.hh.toFixed(1)}" rx="2"/>`);
    const cy = s.y + s.hh / 2 + 4, lx = s.x + 20;
    out.push(`<text class="sk-num" x="${lx}" y="${cy.toFixed(1)}">${s.drop}</text>`);
    out.push(`<text class="sk-lab" x="${lx + String(s.drop).length * 9 + 12}" y="${cy.toFixed(1)}">${esc(DROP_PHRASE[s.i])}</text>`);
    const comp = dropComposition[s.i].slice(0, 5).map(c => `${c.count} ${c.status.toLowerCase()}`).join(" · ");
    if (comp) out.push(`<text class="sk-sub" x="${lx}" y="${(cy + 18).toFixed(1)}">${esc(comp)}</text>`);
    maxY = Math.max(maxY, s.y + s.hh, cy + (comp ? 24 : 6));
  }
  if (reached[4] === 0) out.push(`<text class="sk-sub" x="${xs[4] - 18}" y="62">none</text>`);

  const H = Math.ceil(maxY + 16);
  const aria = `Stage flow: of ${reached[0]} applications, ${reached[0] - reached[1]} never got past ` +
    `the application stage, ${reached[1]} drew a reply, ${reached[2]} reached an assessment, ` +
    `${reached[3]} reached an interview and ${reached[4]} reached an offer.`;

  return `<svg viewBox="0 0 ${W} ${Math.round(H)}" role="img" aria-label="${aria}">\n${out.map(p => "  " + p).join("\n")}\n</svg>`;
}

/* ================================================================== *
 * 5. Render
 * ================================================================== */

const HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Job Search Analytics</title>
</head>
<body>
`;
const FOOT = `
</body>
</html>
`;

async function main() {
  const raw = await fetchFeedRecords();

  if (!raw.length) throw new Error("Feed table returned zero records — check AIRTABLE_BASE_ID/AIRTABLE_TABLE_NAME.");
  if (!("Status" in raw[0].fields)) {
    throw new Error(`Feed table has no "Status" field. Fields found: ${Object.keys(raw[0].fields).join(", ")}`);
  }

  const records = toRecords(raw);

  const agg = aggregate(records);
  const template = await readFile(join(ROOT, "templates/dashboard.html"), "utf8");

  const body = template
    .replaceAll("{{GENERATED_AT}}", formatPHT(agg.generatedAt))
    .replaceAll("{{SANKEY}}", sankeySVG(agg))
    .replaceAll("{{DATA_JSON}}", JSON.stringify(agg));

  if (body.includes("{{")) {
    const left = [...body.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
    throw new Error(`Template placeholders left unfilled: ${[...new Set(left)].join(", ")}`);
  }

  await mkdir(join(ROOT, "dist"), { recursive: true });
  await writeFile(join(ROOT, "dist/index.html"), HEAD + body + FOOT);
  // The artifact host wraps content in its own skeleton, so ship the body alone.
  await writeFile(join(ROOT, "dist/artifact.html"), body);

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(join(ROOT, "data/summary.json"), JSON.stringify(agg, null, 2) + "\n");

  console.log(
    `Built ${agg.total} rows (${agg.sent} sent, ${agg.unsent} unsent)\n` +
    `  funnel     ${agg.reached.join(" → ")}\n` +
    `  reply rate ${(agg.replyRate * 100).toFixed(1)}%   interview ${(agg.interviewRate * 100).toFixed(1)}%\n` +
    `  charts     ${agg.channels.length} channels · ${agg.monthly.length} months · ` +
    `${agg.workSetup.length} setups · ${agg.ageing.length} age buckets`
  );
}

main().catch(err => {
  console.error("\nBuild failed:", err.message, "\n");
  process.exit(1);
});
