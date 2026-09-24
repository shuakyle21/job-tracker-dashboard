// Body of the "Decide Webhook Action" Code node (mode: runOnceForEachItem).
//
// Source of truth, like parse-email.js: scripts/build-n8n.mjs inlines it into
// n8n/job-tracker-feed-sync.json and scripts/verify.mjs fails if the two
// drift. Test it outside n8n with: node scripts/test-airtable-webhook.mjs
//
// Contract: $json is Airtable's list-webhooks response ({ webhooks: [...] }).
// Returns { json: { action, webhookId, createBody, others, reason } } where
// action is 'create', 'refresh' or 'enable' (enable, then refresh).
//
// Why this exists: a webhook created with a personal access token expires 7
// days after it was created or last refreshed — whatever the token's own
// expiry is — and Airtable switches its notifications off after ~a day of
// failed pings. Either one silently puts Feed edits back on the 6-hourly cron.
// Running this daily keeps exactly one healthy webhook pointed at n8n.
//
// Unlike the email parser this one throws on a malformed list response: it
// runs once a day, not per email, so a failed execution is the loud signal we
// want, where a guessed 'create' could pile up duplicate webhooks (Airtable
// allows 10 per base).

// The receiver's production URL. scripts/verify.mjs checks it ends in the
// Webhook node's path, so the two can't point at different places.
const NOTIFICATION_URL = 'https://n8n.shua-kyle.me/webhook/job-tracker-feed-changed';
const FEED_TABLE_ID = 'tblPZSpJ8P4iFuAhX';

// Every change to Feed, from every source. No fromSources filter: records
// written through the API (n8n itself, the Airtable MCP) must fire too. No
// watchDataInFieldIds: whether a record *add* passes that filter is
// unverified, and a spurious rebuild is harmless — deploy.yml's
// cancel-in-progress collapses bursts to one run.
const SPECIFICATION = {
  options: { filters: { dataTypes: ['tableData'], recordChangeScope: FEED_TABLE_ID } },
};

if (!$json || !Array.isArray($json.webhooks)) {
  throw new Error('Airtable list-webhooks response has no webhooks array: '
    + JSON.stringify($json).slice(0, 300));
}

const now = Date.now();
const ours = $json.webhooks.filter((w) => w && w.notificationUrl === NOTIFICATION_URL);

// An expired or disabled hook can't be revived by a refresh, so it doesn't
// count as ours any more. A missing expirationTime means it never expires.
// An unreadable one is treated as live: refreshing it fails loudly if it
// isn't, where treating it as dead would add a duplicate webhook every day.
const expiry = (w) => {
  const t = w.expirationTime ? Date.parse(w.expirationTime) : Infinity;
  return Number.isNaN(t) ? Infinity : t;
};
const alive = ours
  .filter((w) => w.isHookEnabled !== false && expiry(w) > now)
  .sort((a, b) => expiry(b) - expiry(a));

const best = alive[0];
const others = ours.filter((w) => w !== best).map((w) => w.id);
const createBody = { notificationUrl: NOTIFICATION_URL, specification: SPECIFICATION };

let action = 'create';
let reason = ours.length ? 'every webhook for this URL is expired or disabled' : 'no webhook for this URL';
if (best) {
  action = best.areNotificationsEnabled === false ? 'enable' : 'refresh';
  reason = action === 'enable' ? 'notifications were switched off after failed pings' : 'healthy';
}

return { json: { action, webhookId: best ? best.id : '', createBody, others, reason } };
