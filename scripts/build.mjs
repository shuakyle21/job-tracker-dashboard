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
 *         dist/data/summary.json same aggregate, deploy-only, lets the live page
 *                             detect a newer build without a full redeploy
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

// Each stage's losses, split in two. Rejected is an answer; stalled is silence or
// a status that never moved. Offer has neither: it is the last column.
const STALL_PHRASE = [
  "never got past the application",
  "stalled after the employer replied",
  "stalled at the assessment",
  "stalled after interview",
];
const REJECT_PHRASE = [
  "rejected at the application",
  "rejected after a reply",
  "rejected after the assessment",
  "rejected after interview",
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

  // Rejections split out of each stage's drop-off, so the Sankey can draw them as
  // their own branch. Same stageOf() bucketing, so a rejection after an interview
  // lands at the interview, not back at "applied".
  const rejectedAt = compMaps.map(m =>
    [...m.entries()].filter(([s]) => s.toLowerCase() === "rejected").reduce((a, [, n]) => a + n, 0)
  );
  const rejected = rejectedAt.reduce((a, b) => a + b, 0);

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
    rejected,
    rejectionRate: sent ? rejected / sent : null,
    reached, atStage, dropComposition, rejectedAt, usedExplicitStage,
    byStatus, channels, monthly, workSetup, ageing,
    followUps: { overdue, dueToday, dueWeek },
    quality,
  };
}

/* ================================================================== *
 * 4. Sankey layout (ApexCharts has no Sankey type, so this is hand-drawn)
 * ================================================================== */

function sankeySVG(agg) {
  const { reached, atStage, dropComposition, rejectedAt, rejected } = agg;
  const HEAD_Y = 20, PAD_TOP = 48, NODE_W = 12, W = 1000;
  const K = reached[0] > 0 ? 300 / reached[0] : 0;
  const xs = [40, 268, 496, 700, 880];
  // How far each loss branch travels before its stub. The last one is short
  // because its label has to fit before the 1000px edge.
  const REACH = [98, 100, 100, 44];
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const f = (n) => n.toFixed(1);
  const h = (n) => n * K;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0) + "%";
  const numW = (n) => String(n).length * 9 + 12;
  const flows = [], nodes = [], text = [];

  // Inline SVG clips at the viewBox, and the right-hand stages have little room,
  // so a status list is cut to the width it has rather than to an entry count.
  // The branch tooltip keeps the full list. ~6.2px per character at 11px.
  const fitList = (items, px) => {
    const budget = Math.floor(px / 6.2);
    let line = "";
    for (let k = 0; k < items.length; k++) {
      const next = line ? `${line} · ${items[k]}` : items[k];
      const more = k < items.length - 1 ? ` · +${items.length - k - 1} more` : "";
      if ((next + more).length > budget) return line ? `${line} · +${items.length - k} more` : `+${items.length} more`;
      line = next;
    }
    return line;
  };

  const ribbon = (cls, x1, s0, s1, x2, d0, d1, tip) => {
    const mx = (x1 + x2) / 2;
    return `<path class="${cls}" d="M${x1} ${f(s0)} C${mx} ${f(s0)}, ${mx} ${f(d0)}, ${x2} ${f(d0)} ` +
      `L${x2} ${f(d1)} C${mx} ${f(d1)}, ${mx} ${f(s1)}, ${x1} ${f(s1)} Z"><title>${esc(tip)}</title></path>`;
  };

  // --- forward flow along the top ------------------------------------
  for (let i = 0; i < 4; i++) {
    const carry = reached[i + 1];
    if (carry <= 0) continue;
    flows.push(ribbon("sk-flow", xs[i] + NODE_W, PAD_TOP, PAD_TOP + h(carry), xs[i + 1], PAD_TOP, PAD_TOP + h(carry),
      `${carry} of ${reached[i]} moved from ${STAGE_LABELS[i]} to ${STAGE_LABELS[i + 1]} (${pct(carry, reached[i])})`));
  }

  // --- stage headers: count, name, and conversion from the stage before ----
  for (let i = 0; i < 5; i++) {
    text.push(`<text class="sk-num" x="${xs[i]}" y="${HEAD_Y}">${reached[i]}</text>`);
    text.push(`<text class="sk-lab" x="${xs[i] + numW(reached[i])}" y="${HEAD_Y}">${esc(STAGE_LABELS[i])}</text>`);
    if (i > 0 && reached[i] > 0) {
      text.push(`<text class="sk-sub" x="${xs[i]}" y="${HEAD_Y + 17}">${pct(reached[i], reached[i - 1])} conversion</text>`);
    }
    const tip = `${reached[i]} reached ${STAGE_LABELS[i]}` + (i ? ` (${pct(reached[i], reached[0])} of all rows)` : "");
    nodes.push(reached[i] > 0
      ? `<rect class="${i === 4 ? "sk-node-win" : "sk-node"}" x="${xs[i]}" y="${PAD_TOP}" width="${NODE_W}" height="${f(h(reached[i]))}" rx="2"><title>${esc(tip)}</title></rect>`
      : `<rect class="sk-empty" x="${xs[i]}" y="${PAD_TOP - 2}" width="${NODE_W}" height="18" rx="2"/>`);
  }
  if (reached[4] === 0) text.push(`<text class="sk-sub" x="${xs[4] - 18}" y="${PAD_TOP + 34}">none</text>`);

  // Offer is the last column, so it has no room for loss branches. A rejection
  // after an offer still counts in the legend total, so say so here rather than
  // let the two numbers disagree silently.
  if (rejectedAt[4] > 0) {
    text.push(`<text class="sk-sub" x="${xs[4]}" y="${f(PAD_TOP + h(reached[4]) + 16)}">${rejectedAt[4]} later rejected</text>`);
  }

  // --- where each stage's losses went: stalled (grey) and rejected (red) ----
  // Labels run rightwards under the columns that follow, so each stage's block is
  // stacked below the block of the stage to its right. That ordering, not
  // hand-tuned offsets, is what keeps a long label from running through a
  // neighbour's branch however the counts change.
  let maxY = PAD_TOP + h(reached[0]);
  let floor = -Infinity;
  for (let i = 3; i >= 0; i--) {
    if (atStage[i] <= 0) continue;
    const rej = rejectedAt[i];
    const stall = atStage[i] - rej;
    const x1 = xs[i] + NODE_W, x2 = x1 + REACH[i];
    let src = PAD_TOP + h(reached[i + 1]);
    let y = Math.max(src + 44, floor + 20);

    // Grey on top, red below, matching their order on the node, so the two
    // branches never cross.
    const comp = dropComposition[i].filter(c => c.status.toLowerCase() !== "rejected")
      .map(c => `${c.count} ${c.status.toLowerCase()}`);
    const parts = [
      { n: stall, cls: "sk-loss", node: "sk-node-loss", num: "sk-num", phrase: STALL_PHRASE[i],
        sub: fitList(comp, W - 8 - (x2 + 20)), full: comp.join(" · ") },
      { n: rej, cls: "sk-rej", node: "sk-node-rej", num: "sk-num-rej", phrase: REJECT_PHRASE[i],
        sub: rejected ? `${pct(rej, rejected)} of all rejections` : "" },
    ];
    for (const p of parts) {
      if (p.n <= 0) continue;
      const hh = h(p.n);
      flows.push(ribbon(p.cls, x1, src, src + hh, x2, y, y + hh,
        `${p.n} ${p.phrase}` + (p.full ? `: ${p.full}` : "")));
      nodes.push(`<rect class="${p.node}" x="${x2}" y="${f(y)}" width="${NODE_W}" height="${f(hh)}" rx="2"/>`);
      const cy = y + Math.max(hh, 14) / 2 + 4, lx = x2 + 20;
      text.push(`<text class="${p.num}" x="${lx}" y="${f(cy)}">${p.n}</text>`);
      text.push(`<text class="sk-lab" x="${lx + numW(p.n)}" y="${f(cy)}">${esc(p.phrase)}</text>`);
      if (p.sub) text.push(`<text class="sk-sub" x="${lx}" y="${f(cy + 17)}">${esc(p.sub)}</text>`);
      const bottom = Math.max(y + hh, cy + (p.sub ? 22 : 6));
      src += hh;
      y = bottom + 10;
      floor = bottom;
      maxY = Math.max(maxY, bottom);
    }
  }

  const H = Math.ceil(maxY + 16);
  const aria = `Stage flow: of ${reached[0]} applications, ${reached[1]} drew a reply, ${reached[2]} reached an ` +
    `assessment, ${reached[3]} reached an interview and ${reached[4]} reached an offer. ` +
    `${rejected} were rejected: ${rejectedAt.slice(0, 4).map((n, i) => `${n} ${REJECT_PHRASE[i].replace(/^rejected /, "")}`).join(", ")}` +
    (rejectedAt[4] ? `, ${rejectedAt[4]} after an offer.` : ".");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">\n` +
    [...flows, ...nodes, ...text].map(p => "  " + p).join("\n") + `\n</svg>`;
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
<title>Job Search Analytics Dashboard</title>
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

  // Same aggregate, shipped inside dist/ so the deployed page can fetch it and
  // notice a newer build landed — data/summary.json above never reaches Vercel.
  await mkdir(join(ROOT, "dist/data"), { recursive: true });
  await writeFile(join(ROOT, "dist/data/summary.json"), JSON.stringify(agg, null, 2) + "\n");

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
