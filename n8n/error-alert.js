// Body of the "Format Alert" Code node (mode: runOnceForAllItems) in the
// Error alert workflow. Source of truth: scripts/build-n8n.mjs inlines it and
// verify.mjs fails on drift. Test with: node scripts/test-error-alert.mjs
//
// Input is n8n's Error Trigger payload. A failed execution carries `execution`;
// a polling trigger that failed before any execution existed (an expired Gmail
// token, a quota hit in Poll Gmail) carries only `trigger`. Returns one
// { text } item for Telegram, or nothing when this error was already sent
// within REPEAT_MS: the hourly stale-mail alarm once failed 135 times in a row,
// which is spam, but a single alert for a 6-day outage is too quiet.

const REPEAT_MS = 6 * 3600e3;
const { workflow = {}, execution, trigger } = $input.first().json;
const err = execution?.error ?? trigger?.error ?? {};
const node = execution?.lastNodeExecuted ?? err.node?.name ?? 'trigger';
const message = String(err.message || err.description || 'Unknown error').slice(0, 300);

const tag = /reconnect|EAUTH|invalid_grant|\b401\b|requires authentication|unauthori[sz]ed/i.test(message)
  ? 'CREDENTIAL — re-authenticate it in n8n (DEPLOY.md §3.5)'
  : /quota|rate.?limit|\b429\b/i.test(message) ? 'QUOTA — Gmail will recover; rerun Backfill if mail is stuck'
  : 'ERROR';

const seen = $getWorkflowStaticData('global');
const now = Date.now();
for (const k of Object.keys(seen)) if (now - seen[k] >= REPEAT_MS) delete seen[k];
const key = `${workflow.id}|${node}|${message.replace(/\d+/g, '#')}`;
if (seen[key]) return [];
seen[key] = now;

return [{ json: { text: [
  `⚠️ ${workflow.name || 'n8n workflow'} failed`,
  `${tag}`,
  `Node: ${node}`,
  message,
  execution?.url || '',
].filter(Boolean).join('\n') } }];
