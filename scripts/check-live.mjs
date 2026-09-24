#!/usr/bin/env node
/**
 * Checks what n8n is actually running against what this repo generates.
 *
 * verify.mjs proves the committed workflow JSON matches its generator. It can't
 * see the n8n instance, and that's where this pipeline broke before: the live
 * ingest was edited in place until its Gmail trigger ANDed three labels and
 * missed every rejection, while every check here stayed green. This fails when:
 *
 *   - a generated workflow is missing, duplicated or inactive on the instance
 *   - its live nodes or connections differ from the generated JSON
 *   - one credential is shared between GitHub dispatch and any other node
 *   - it had error executions recently (this includes the ingest's hourly
 *     "Stale Job Mail Alarm" and the Feed webhook keep-alive)
 *   - the running (published) version differs from the draft
 *
 * Runs hourly from .github/workflows/health.yml, where a failure emails you.
 *
 *   N8N_API_URL=https://n8n.example.com N8N_API_KEY=... node scripts/check-live.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const GENERATED = ["n8n/job-tracker-ingest.json", "n8n/job-tracker-feed-sync.json"];

// Node settings that change behaviour. Positions, ids and credential ids/names
// are the instance's business and are ignored; credential *types* are not.
const BEHAVIOUR = ["type", "typeVersion", "disabled", "onError", "executeOnce",
  "alwaysOutputData", "retryOnFail", "maxTries", "waitBetweenTries"];

// n8n fills in defaults when a workflow is saved: empty objects, empty
// arrays, nulls. Those aren't drift. A non-empty value that the generator
// didn't write is, which is exactly what the extra labelIds filter was.
function strip(value) {
  if (Array.isArray(value)) {
    const items = value.map(strip).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, strip(v)])
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === null || value === undefined ? undefined : value;
}

function normalizeNode(node) {
  const flags = Object.fromEntries(BEHAVIOUR.map((k) => [k, node[k] ?? null]));
  // An explicit default is not drift. The n8n UI writes these when someone
  // merely opens a node's Settings tab: disabled:false, onError:"stopWorkflow",
  // and maxTries/waitBetweenTries even while retries are off.
  for (const k of ["disabled", "executeOnce", "alwaysOutputData", "retryOnFail"]) flags[k] = Boolean(flags[k]);
  if (flags.onError === "stopWorkflow") flags.onError = null;
  if (!flags.retryOnFail) flags.maxTries = flags.waitBetweenTries = null;
  return {
    ...flags,
    parameters: strip(node.parameters ?? {}) ?? {},
    credentialTypes: Object.keys(node.credentials ?? {}).sort(),
  };
}

function edges(wf) {
  const out = [];
  for (const [src, conn] of Object.entries(wf.connections ?? {})) {
    for (const [i, targets] of (conn.main ?? []).entries()) {
      for (const t of targets ?? []) out.push(`${src}[${i}] -> ${t.node}[${t.index ?? 0}]`);
    }
  }
  return out.sort();
}

// First path at which two values differ, for a readable report.
function firstDifference(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDifference(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
  }
  return `${path || "(value)"}: expected ${JSON.stringify(a)?.slice(0, 120)}, live ${JSON.stringify(b)?.slice(0, 120)}`;
}

const isNote = (n) => n.type === "n8n-nodes-base.stickyNote";

/** Differences between a generated workflow and the live one, as sentences. */
export function diffWorkflows(generated, live) {
  const problems = [];
  const gen = new Map(generated.nodes.filter((n) => !isNote(n)).map((n) => [n.name, n]));
  const liv = new Map((live.nodes ?? []).filter((n) => !isNote(n)).map((n) => [n.name, n]));
  for (const name of gen.keys()) if (!liv.has(name)) problems.push(`node "${name}" is missing on the instance`);
  for (const name of liv.keys()) if (!gen.has(name)) problems.push(`node "${name}" exists on the instance but not in the generator`);
  for (const [name, node] of gen) {
    if (!liv.has(name)) continue;
    const d = firstDifference(normalizeNode(node), normalizeNode(liv.get(name)));
    if (d) problems.push(`node "${name}" differs at ${d}`);
  }
  const want = edges(generated);
  const have = edges(live);
  for (const e of want) if (!have.includes(e)) problems.push(`connection missing: ${e}`);
  for (const e of have) if (!want.includes(e)) problems.push(`unexpected connection: ${e}`);
  return problems;
}

/**
 * The version n8n is actually running. With draft/publish, GET /workflows/{id}
 * returns the draft; an unpublished edit is not running, and an unpublished
 * revert doesn't undo what is. (This is how a "disabled" Feed poller kept
 * firing: the draft disabled it, the published version didn't.)
 */
export function runningVersion(wf) {
  const problems = [];
  if (wf.activeVersionId && wf.versionId && wf.activeVersionId !== wf.versionId) {
    problems.push("has unpublished draft changes; publish or discard them so the draft is what runs");
  }
  const active = wf.activeVersion;
  const running = active?.nodes ? { ...wf, nodes: active.nodes, connections: active.connections ?? {} } : wf;
  return { running, problems };
}

const isDispatch = (n) => /api\.github\.com\/repos\/.+\/dispatches$/.test(n.parameters?.url ?? "");

/** A credential attached to a GitHub dispatch must be attached to nothing else. */
export function findSharedCredentials(workflows) {
  const nodes = workflows.flatMap((wf) => (wf.nodes ?? []).map((n) => ({ ...n, workflow: wf.name })));
  const problems = [];
  for (const d of nodes.filter(isDispatch)) {
    for (const cred of Object.values(d.credentials ?? {})) {
      if (!cred?.id) continue;
      const others = nodes.filter((n) => !isDispatch(n)
        && Object.values(n.credentials ?? {}).some((c) => c?.id === cred.id));
      for (const o of others) {
        problems.push(`"${o.name}" (${o.workflow}) uses the GitHub dispatch credential "${cred.name ?? cred.id}"; the GitHub token is sent to its URL`);
      }
    }
  }
  return problems;
}

/** Error executions that finished inside the window. */
export function recentErrors(executions, now, windowMs) {
  return executions.filter((e) => {
    const at = Date.parse(e.stoppedAt ?? e.startedAt ?? "");
    return e.status === "error" && !Number.isNaN(at) && now - at <= windowMs;
  });
}

async function main() {
  const base = (process.env.N8N_API_URL ?? "").replace(/\/+$/, "");
  const key = process.env.N8N_API_KEY ?? "";
  if (!base || !key) {
    console.error("N8N_API_URL and N8N_API_KEY must be set");
    process.exit(1);
  }
  // Wider than the hourly schedule on purpose: Actions cron is best-effort and
  // a run can land an hour late, which would skip a one-shot failure (the
  // daily keep-alive, a single failed dispatch) entirely. Reporting an error
  // on two consecutive runs is the price of never missing one.
  const windowMs = Number(process.env.CHECK_WINDOW_MINUTES || 150) * 60e3;

  async function api(path) {
    const res = await fetch(`${base}/api/v1${path}`, {
      headers: { "X-N8N-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`GET ${base}/api/v1${path} → HTTP ${res.status} ${body}`);
    }
    return res.json();
  }

  const problems = [];
  const live = [];
  // Filtered by name client-side as well: older n8n versions ignore ?name=.
  const all = (await api("/workflows?limit=250")).data ?? [];

  for (const file of GENERATED) {
    const generated = JSON.parse(await readFile(join(ROOT, file), "utf8"));
    const matches = all.filter((w) => w.name === generated.name && !w.isArchived);
    console.log(`\n${generated.name}`);
    if (matches.length !== 1) {
      problems.push(`${generated.name}: expected 1 workflow with this name, found ${matches.length} (import ${file})`);
      continue;
    }
    const fetched = await api(`/workflows/${matches[0].id}`);
    const { running: wf, problems: versionProblems } = runningVersion(fetched);
    live.push(wf);
    const found = [...versionProblems];
    if (!wf.active) found.push("workflow is not active");
    found.push(...diffWorkflows(generated, wf));

    const executions = (await api(`/executions?workflowId=${wf.id}&status=error&limit=50`)).data ?? [];
    for (const e of recentErrors(executions, Date.now(), windowMs)) {
      found.push(`error execution ${e.id} at ${e.stoppedAt ?? e.startedAt}: ${base}/workflow/${wf.id}/executions/${e.id}`);
    }

    if (found.length === 0) console.log("  ok    active, matches the generator, no recent errors");
    for (const p of found) console.error(`  FAIL  ${p}`);
    problems.push(...found);
  }

  const shared = findSharedCredentials(live);
  for (const p of shared) console.error(`  FAIL  ${p}`);
  problems.push(...shared);

  console.log(problems.length ? `\n${problems.length} problem(s)\n` : "\nLive n8n looks right\n");
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
