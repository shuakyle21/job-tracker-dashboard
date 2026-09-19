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
  'OnlineJobs.ph': 'OnlineJobs.ph', 'Torre': 'Torre.ai', 'Company Website': 'Direct / Careers',
  'Direct Email': 'Direct Email',
};

const oldStatus = row['Status'] || '';
const newStatus = FEED_STATUS[email.status] || '';
const status = !oldStatus || (newStatus && (RANK[newStatus] ?? 0) >= (RANK[oldStatus] ?? 0))
  ? (newStatus || oldStatus)
  : oldStatus;

const dates = [row['Date Applied'], email.received_at].filter(Boolean).sort();

return {
  json: {
    'Application Key': email.application_key,
    'Job Role': row['Job Role'] || email.job_title,
    'Company': row['Company'] || email.company,
    'Job Platform': row['Job Platform'] || email.job_platform,
    'Source': row['Source'] || SOURCE_OF_PLATFORM[email.job_platform] || 'Direct / Careers',
    'Date Applied': dates[0] || '',
    'Status': status,
    'Max Stage': Math.max(Number(row['Max Stage']) || 0, Number(email.max_stage) || 1),
  },
};
