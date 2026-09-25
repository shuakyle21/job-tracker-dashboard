// Body of the "Merge Into Feed" Code node (mode: runOnceForEachItem).
//
// Source of truth, like parse-email.js: scripts/build-n8n.mjs inlines it and
// scripts/verify.mjs fails if the two drift. Test with: node scripts/test-merge-feed.mjs
//
// Contract: $json is the Feed row "Find Feed Row" returned for this email's
// application_key ({} when there is none); $('Parse Job Email').item.json is
// the parsed email. Returns every Feed field the upsert writes, so the upsert
// never blanks a value it wasn't meant to touch.
//
// Emails arrive in any order and a person also edits Feed by hand, so the
// merge only ever moves a row forward: earliest date, highest stage, and a
// status that doesn't slide back from "Interviewed" to "Applied" because a
// late confirmation email turned up.

const email = $('Parse Job Email').item.json;
const row = ($json && ($json.fields || $json)) || {};

const FEED_STATUS = {
  'applied': 'Applied', 'viewed by employer': 'Viewed by Employer', 'in review': 'In Review',
  'assessment': 'Assessment', 'interview scheduled': 'Interviewed', 'offer': 'Offer',
  'rejected': 'Rejected', 'talent pool': 'Talent Pool',
};

// How far along a status is, for "may this replace that?". Not the funnel
// stage: a rejection ends an application at any stage, so it outranks
// everything except an offer.
const RANK = {
  'Materials Ready — VERIFY': 0, 'Applied': 1, 'No Response': 1,
  'Viewed by Employer': 2, 'In Review': 2, 'Talent Pool': 3, 'Assessment': 3,
  'Interviewed': 4, 'Closed / Expired': 5, 'Rejected': 5, 'Offer': 6,
};

// Feed's Source select predates Job Platform and uses its own spellings.
const SOURCE_OF_PLATFORM = {
  'JobStreet': 'Jobstreet', 'LinkedIn': 'LinkedIn', 'Indeed': 'Indeed', 'Kalibrr': 'Kalibrr',
  // Only choices Source already has: a new option would silently add a
  // channel to the dashboard. OnlineJobs.ph has none, so it is a "Platform".
  'OnlineJobs.ph': 'Platform', 'Torre': 'Torre.ai', 'Company Website': 'Direct / Careers',
  'Direct Email': 'Direct Email',
};

const oldStatus = row['Status'] || '';
const newStatus = FEED_STATUS[email.status] || '';
const status = !oldStatus || (newStatus && (RANK[newStatus] ?? 0) >= (RANK[oldStatus] ?? 0))
  ? (newStatus || oldStatus)
  : oldStatus;

const dates = [row['Date Applied'], email.received_at].filter(Boolean).sort();

// Only parsed emails get here, and parse-email.js only parses one with a
// company and a title. A key that breaks that is a bug upstream; writing it
// would create a Feed row no later email can match. Fail the execution instead:
// scripts/check-live.mjs reports error executions, a quiet bad row it cannot see.
const keyParts = String(email.application_key || '').split('|');
if (!email.company || keyParts.length < 2 || keyParts.some((p) => !p || p !== p.trim())) {
  throw new Error('Refusing to write a malformed Feed key ' + JSON.stringify(email.application_key)
    + ' (company ' + JSON.stringify(email.company) + ') for message ' + email.message_id);
}

return {
  json: {
    // Find Feed Row matches a key regardless of case and spacing around "|",
    // but the upsert matches it exactly. Writing the row's own key back is what
    // makes the upsert update that row (e.g. a hand-typed "va masters | dev")
    // instead of creating a twin next to it.
    'Application Key': row['Application Key'] || email.application_key,
    'Job Role': row['Job Role'] || email.job_title,
    'Company': row['Company'] || email.company,
    'Job Platform': row['Job Platform'] || email.job_platform,
    'Source': row['Source'] || SOURCE_OF_PLATFORM[email.job_platform] || 'Direct / Careers',
    'Date Applied': dates[0] || '',
    'Status': status,
    'Max Stage': Math.max(Number(row['Max Stage']) || 0, Number(email.max_stage) || 1),
  },
};
