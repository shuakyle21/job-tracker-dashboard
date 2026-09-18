// Body of the "Parse Job Email" Code node (mode: runOnceForEachItem).
//
// This file is the source of truth. scripts/build-n8n.mjs inlines it into
// n8n/job-tracker-ingest.json, and scripts/verify.mjs fails the build if the
// two drift apart. Test it outside n8n with: node scripts/test-parser.mjs
//
// Contract: reads $json (one Gmail message), returns { json: { ...row } }.
// It never throws — an email it cannot classify comes back with
// parsed:false and is routed to the needs-review tab rather than dropped.

const msg = $json;
const subject = String(msg.subject || '');
const from = String(msg.from?.value?.[0]?.address || msg.from?.text || msg.From || '');
const fromName = String(msg.from?.value?.[0]?.name || '');
const body = String(msg.text || msg.textAsHtml || msg.snippet || '');

// Subject carries the strongest signal and the least boilerplate, so weight it
// by searching it first; fall back to the body only when the subject is mute.
const hay = (subject + '\n' + body).toLowerCase();
const subjectLower = subject.toLowerCase();

function any(text, patterns) {
  for (const p of patterns) if (p.test(text)) return true;
  return false;
}

// --- status classification ------------------------------------------------
// Order is load-bearing. A rejection that follows an interview says both
// "interview" and "unfortunately"; the current status is rejected, so the
// rejection test must run before the interview test. Stage evidence is
// collected separately below so the funnel still gets credit for the interview.
const RULES = [
  ['offer', [
    /\boffer of employment\b/, /\bpleased to offer\b/, /\bjob offer\b/,
    /\bwe(?:'| a)re offering you\b/, /\boffer letter\b/,
  ]],
  ['rejected', [
    /\bunfortunately\b/, /\bregret to inform\b/, /\bnot (?:be )?moving forward\b/,
    /\bnot (?:been )?select(?:ed|ing)\b/, /\bdecided to (?:proceed|move forward) with (?:other|another)\b/,
    /\bposition has been filled\b/, /\bwe(?:'| ha)ve decided not to\b/,
    /\bno longer under consideration\b/, /\bwill not be proceeding\b/,
  ]],
  ['interview scheduled', [
    /\binterview (?:is |has been )?(?:scheduled|confirmed|booked)\b/,
    /\binvit(?:ation|e|ing) (?:you )?(?:to|for) an? (?:interview|call|chat)\b/,
    /\bschedule (?:an?|your) (?:interview|call)\b/, /\bcalendly\.com\b/,
    /\bbook a time\b/, /\bpick a time\b/, /\bavailability for a (?:call|chat|interview)\b/,
  ]],
  ['assessment', [
    /\b(?:online |skills? |technical )?assessment\b/, /\btake[- ]home\b/,
    /\bcoding (?:challenge|test|exercise)\b/, /\bhackerrank\b/, /\bcodility\b/,
    /\btestgorilla\b/, /\bcomplete (?:a|the|this) (?:short )?test\b/,
  ]],
  ['talent pool', [
    /\btalent (?:pool|community|network)\b/, /\bkeep your (?:resume|cv|profile) on file\b/,
    /\bfuture (?:opportunities|openings|roles)\b/,
  ]],
  ['viewed by employer', [
    /\byour application was viewed\b/, /\bviewed your application\b/,
    /\bapplication (?:was )?viewed\b/, /\brecruiter viewed\b/,
  ]],
  ['in review', [
    /\bunder review\b/, /\breviewing your application\b/, /\bbeing reviewed\b/,
    /\bshortlist(?:ed|ing)?\b/, /\bmoved to the next (?:stage|round)\b/,
    /\bprogress(?:ed|ing) to\b/,
  ]],
  ['applied', [
    /\bapplication (?:was |has been )?(?:sent|submitted|received)\b/,
    /\bthank you for (?:applying|your application|your interest)\b/,
    /\bwe(?:'| ha)ve received your application\b/, /\bapplication confirmation\b/,
    /\bsuccessfully applied\b/,
  ]],
];

let status = '';
for (const [name, patterns] of RULES) {
  if (any(subjectLower, patterns) || any(hay, patterns)) { status = name; break; }
}

// --- furthest stage reached ----------------------------------------------
// A rejection tells you an application ended, not how far it got. If the same
// email mentions an interview or an assessment, that is evidence the funnel
// should credit — this is the max_stage column the dashboard reads, filled in
// automatically instead of by hand.
const STAGE_OF_STATUS = {
  'applied': 1, 'no response': 1, 'closed / expired': 1, 'rejected': 1,
  'viewed by employer': 2, 'in review': 2, 'talent pool': 2,
  'assessment': 3, 'interview scheduled': 4, 'interviewed': 4, 'offer': 5,
};

let stageEvidence = 1;
if (any(hay, [/\breview(?:ed|ing)?\b/, /\bviewed\b/, /\bshortlist/])) stageEvidence = 2;
if (any(hay, [/\bassessment\b/, /\btake[- ]home\b/, /\bcoding (?:challenge|test)\b/])) stageEvidence = 3;
if (any(hay, [/\binterview(?:ed|ing)?\b/, /\bcalendly\b/])) stageEvidence = 4;
if (any(hay, [/\boffer of employment\b/, /\boffer letter\b/])) stageEvidence = 5;

const maxStage = Math.max(STAGE_OF_STATUS[status] || 1, stageEvidence);

// --- company --------------------------------------------------------------
// The From display name is the most reliable source, but ATS senders bury the
// company in boilerplate. Strip the boilerplate rather than guess.
let company = fromName
  .replace(/\s+via\s+LinkedIn\s*$/i, '')
  .replace(/^(?:no[- ]?reply|do[- ]?not[- ]?reply|notifications?|jobs?|careers?|recruiting|talent|hr)\b[\s@:-]*/i, '')
  .replace(/\b(?:careers?|recruiting|recruitment|talent(?:\s+acquisition)?|hiring|hr|jobs?|team|no[- ]?reply)\b/gi, '')
  .replace(/[|()\[\]]/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .replace(/^[\s,.\-–—]+|[\s,.\-–—]+$/g, '')
  .trim();

// Fall back to the sending domain, minus the ATS hosts that tell you nothing
// about who the employer is.
const ATS_DOMAINS = /^(?:.*\.)?(?:linkedin|indeed|greenhouse|lever|workday(?:day)?|myworkday|jobstreet|glassdoor|ziprecruiter|smartrecruiters|ashbyhq|workable|bamboohr|onlinejobs|gmail|googlemail|outlook|yahoo)\./i;
if (!company) {
  const domain = (from.split('@')[1] || '').toLowerCase();
  if (domain && !ATS_DOMAINS.test(domain + '.')) {
    company = domain.replace(/\.(?:com|net|org|io|co|ph|ai|dev)(?:\.[a-z]{2})?$/i, '');
    company = company.charAt(0).toUpperCase() + company.slice(1);
  }
}

// --- job title ------------------------------------------------------------
// Subjects follow a handful of shapes. Peel the known prefixes, then take what
// is left up to the first separator.
// Subject lines stack boilerplate: "Invitation to interview — Full Stack
// Developer at Q2Q". One pass over the lead-ins is not enough, because
// stripping one exposes the next, so run the list until it stops shrinking.
// Each pattern also eats a trailing separator, otherwise the split below
// mistakes the leftover boilerplate for the job title.
const LEAD_INS = [
  /^(?:re|fwd?)\s*:\s*/i,
  /^invitation (?:to|for) (?:an? )?(?:interview|call|chat)\s*(?:for|with)?\s*[:\u2014\u2013-]?\s*/i,
  /^(?:your )?application (?:for|to|update(?: for)?|status(?: for)?|received(?: for)?|confirmation(?: for)?)\s*[:\u2014\u2013-]?\s*/i,
  /^thank you for (?:applying|your (?:application|interest))(?: (?:to|in|for))?\s*[:\u2014\u2013-]?\s*/i,
  /^(?:next steps?|update|interview|assessment|invitation)\s*(?:on|for|regarding|about)?\s*(?:your )?(?:application)?\s*[:\u2014\u2013-]\s*/i,
  /^you(?:r)? (?:have )?applied (?:to|for)\s*[:\u2014\u2013-]?\s*/i,
];

let title = subject.trim();
let shrinking = true;
let passes = 0;
while (shrinking && passes < 4) {
  const before = title;
  for (const re of LEAD_INS) title = title.replace(re, '').trim();
  shrinking = title.length < before.length;
  passes = passes + 1;
}

const atMatch = title.match(/^(.+?)\s+(?:at|@|with|-|–|—|\|)\s+(.+)$/);
if (atMatch) {
  title = atMatch[1].trim();
  // The right-hand side is usually the company; trust it over a stripped
  // display name, which is often just "Careers".
  const candidate = atMatch[2].replace(/[|()\[\]].*$/, '').trim();
  if (candidate && candidate.length < 60 && (!company || /^careers?$/i.test(company))) {
    company = candidate;
  }
}
title = title.replace(/\s*[|(].*$/, '').replace(/\s{2,}/g, ' ').trim();

// --- confidence and routing ----------------------------------------------
// A row is only trustworthy enough to land in the tracker when the email said
// something recognisable AND we know who sent it. Everything else goes to
// needs-review, where a human decides in ten seconds.
const parsed = Boolean(status) && Boolean(company) && Boolean(title);

let confidence = 'low';
if (status && company && title) confidence = 'high';
else if (status && (company || title)) confidence = 'medium';

// Gmail gives an RFC-2822 date on some shapes and epoch milliseconds on
// others, and a malformed header gives neither. new Date(garbage).toISOString()
// throws, which would fail the execution and leave the email unlabelled — so it
// would be re-polled and re-fail forever. Validate before formatting.
const receivedAt = msg.date || msg.internalDate;
const stamp = /^\d+$/.test(String(receivedAt)) ? Number(receivedAt) : receivedAt;
const asDate = receivedAt ? new Date(stamp) : new Date();
const isoDate = Number.isNaN(asDate.getTime())
  ? new Date().toISOString().slice(0, 10)
  : asDate.toISOString().slice(0, 10);

return {
  json: {
    message_id: String(msg.id || msg.messageId || ''),
    thread_id: String(msg.threadId || ''),
    received_at: isoDate,
    company,
    job_title: title,
    status,
    max_stage: maxStage,
    source: /linkedin/i.test(from) ? 'LinkedIn'
      : /indeed/i.test(from) ? 'Indeed'
      : /jobstreet/i.test(from) ? 'JobStreet'
      : /onlinejobs/i.test(from) ? 'OnlineJobs.ph'
      : 'Email',
    from_address: from,
    subject,
    parsed,
    confidence,
  },
};
