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
    /\byour application was viewed\b/, /\b(?:has )?viewed your application\b/,
    /\bapplication (?:was )?viewed\b/, /\brecruiter viewed\b/,
  ]],
  ['in review', [
    /\bunder review\b/, /\breviewing your application\b/, /\bbeing reviewed\b/,
    // "You have been shortlisted", not "if shortlisted, we will call" — the
    // conditional is boilerplate in plain confirmations.
    /\b(?:you(?:'ve| have)? been|you are|you're) shortlisted\b/, /\bmoved to the next (?:stage|round)\b/,
    /\bprogress(?:ed|ing) to\b/,
  ]],
  ['applied', [
    // Real confirmations don't agree on wording: JobStreet says "was
    // successfully submitted to", LinkedIn "was sent to", Torre "was
    // delivered", ATS mail "has been received" / "we've received". The
    // optional "for <title>" lets "application for X was submitted" match too.
    /\bapplication (?:for .{1,120}? )?(?:was |has been )?(?:successfully )?(?:sent|submitted|received|delivered)\b/,
    /\bsuccessfully submitted\b/,
    /\bthank(?:s| you) for (?:applying|your application|your interest|your submission)\b/,
    /\bwe(?:'| ha)ve received your application\b/, /\breceived your application\b/,
    /\bconfirm that we have received\b/, /\bapplication confirmation\b/,
    /\bsuccessfully applied\b/,
  ]],
];

// Gmail marks mail you sent with SENT. An outgoing email under the job label
// is you applying directly — there is no reply to classify.
// The trigger and the getAll node don't agree on the shape: labelIds is an
// array of ids on some, labels an array of {id, name} on others. Read both.
const labelIds = [
  ...(Array.isArray(msg.labelIds) ? msg.labelIds : []),
  ...(Array.isArray(msg.labels) ? msg.labels.map((l) => (l && (l.id || l.name)) || '') : []),
];
const isSent = labelIds.includes('SENT');

let status = '';
if (isSent) status = 'applied';
else {
  for (const [name, patterns] of RULES) {
    if (any(subjectLower, patterns) || any(hay, patterns)) { status = name; break; }
  }
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
if (any(hay, [/\breview(?:ed|ing)?\b/, /\bviewed\b/, /\bbeen shortlisted\b/])) stageEvidence = 2;
if (any(hay, [/\bassessment\b/, /\btake[- ]home\b/, /\bcoding (?:challenge|test)\b/])) stageEvidence = 3;
if (any(hay, [/\binterview(?:ed|ing)?\b/, /\bcalendly\b/])) stageEvidence = 4;
if (any(hay, [/\boffer of employment\b/, /\boffer letter\b/])) stageEvidence = 5;

const maxStage = Math.max(STAGE_OF_STATUS[status] || 1, stageEvidence);

// status → Gmail sub-label name. scripts/build-n8n.mjs maps each name to a
// label id, and verify.mjs fails if any name here has no id there.
const STATUS_LABELS = {
  'applied': 'Applied', 'viewed by employer': 'Viewed', 'in review': 'In Review',
  'assessment': 'Assessment', 'interview scheduled': 'Interview', 'offer': 'Offer',
  'rejected': 'Rejected', 'talent pool': 'Talent Pool',
};

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

// For mail you sent, the employer is the recipient, not you.
const to = String(msg.to?.value?.[0]?.address || msg.to?.text || '');
if (isSent) company = '';

// Fall back to the sending domain, minus the ATS hosts that tell you nothing
// about who the employer is.
const ATS_DOMAINS = /^(?:.*\.)?(?:linkedin|indeed|greenhouse|lever|workday(?:day)?|myworkday|jobstreet|glassdoor|ziprecruiter|smartrecruiters|ashbyhq|workable|workablemail|bamboohr|teamtailor-mail|teamtailor|manatal|applytojob|appsheet|kalibrr|torre|onlinejobs|gmail|googlemail|outlook|yahoo)\./i;
if (!company) {
  const domain = ((isSent ? to : from).split('@')[1] || '').toLowerCase();
  if (domain && !ATS_DOMAINS.test(domain + '.')) {
    company = domain.replace(/\.(?:com|net|org|io|co|ph|ai|dev|gov|edu)(?:\.[a-z]{2})?$/i, '');
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
  /^thank(?:s| you) for (?:applying|your (?:application|interest))(?: (?:to|in|for|at))?\s*[:\u2014\u2013-]?\s*/i,
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
title = title.replace(/\s*[|(].*$/, '').replace(/\s+(?:position|role)$/i, '').replace(/\s{2,}/g, ' ').trim();

// --- sender-specific shapes -----------------------------------------------
// The heuristics above read the subject; these read sentences the big senders
// actually use, which name both the job and the employer. When one matches it
// is more reliable than anything guessed from a display name, so it wins.
// Company names end in "Inc." / "Ltd." — keep that period, drop a sentence one.
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  .replace(/(?<!\b(?:inc|ltd|corp|co|llc))\.$/i, '').trim();
// A real job title is never a bare article/pronoun. Extractors with no anchor
// past their keyword (e.g. "...applying for <T> job") can otherwise pick up a
// stray "a"/"the" out of unrelated boilerplate, like a safety disclaimer.
const isPlausibleTitle = (s) => !/^(?:a|an|the|this|that|it)$/i.test(s);
const EXTRACTORS = [
  // JobStreet: "your application for <T> was successfully submitted to <C>"
  [body, /application for (.+?) was successfully submitted to (.+?)(?=\s*(?:\n|jobstreet\b|$))/i, 1, 2],
  // JobStreet: "<C> has viewed your application for <T>"
  [subject, /^(.+?) has viewed your application for (.+)$/i, 2, 1],
  // LinkedIn: subject names the company; the body's next line is the title.
  [body, /your application was sent to ([^\n]+)\n+\s*([^\n]+)/i, 2, 1],
  [subject, /your application was sent to (.+)$/i, 0, 1],
  [subject, /your application was viewed by (.+)$/i, 0, 1],
  // Kalibrr: "Application sent to <T> at <C>!"
  [subject, /^application sent to (.+?) at (.+?)!?$/i, 1, 2],
  // Indeed: the subject carries the title and nothing else.
  [subject, /^indeed application:\s*(.+)$/i, 1, 0],
  // ATS / careers-page mail.
  [body, /interest in (?:the )?(.+?) (?:position|role|opportunity) at ([^\n!]+?)(?=[.!,]\s|[.!]?\s*$|\n)/i, 1, 2],
  [body, /(?:application|applying|apply) for (?:the )?(.+?) (?:role|position|job|opportunity) at ([^\n!]+?)(?=[.!,]\s|[.!]?\s*$|\n)/i, 1, 2],
  // No anchor past the keyword here, so this also matches unrelated boilerplate
  // — a safety disclaimer ("never share your bank details when applying for a
  // job") reads as "applying for <a> job" and would otherwise capture the
  // article "a" as the title. isPlausibleTitle() below rejects that.
  [body, /(?:application|applying|apply) for (?:the )?(.+?) (?:role|position|job|opportunity)\b/i, 1, 0],
  // "your application for <T> was delivered" (Torre), "...for <T>, and" (Lever),
  // "...for <T> shortly" (Teamtailor), "...for <T>. If" (Manatal).
  [body, /your application for (?:the )?(.+?)(?= was\b| shortly\b| and\b|,|\.\s|\.?\n|\.?$)/i, 1, 0],
  // "Thank you for your interest in joining <C>, ..." — names the employer
  // when the sender is a person or an ATS.
  [body, /interest in joining ([^,!.\n]+)/i, 0, 1],
];
let gotTitle = false;
let gotCompany = false;
for (const [text, re, ti, ci] of EXTRACTORS) {
  const m = String(text).match(re);
  if (!m) continue;
  if (ti && !gotTitle && clean(m[ti]) && isPlausibleTitle(clean(m[ti]))) { title = clean(m[ti]); gotTitle = true; }
  if (ci && !gotCompany && clean(m[ci])) { company = clean(m[ci]); gotCompany = true; }
  if (gotTitle && gotCompany) break;
}

// --- job platform ---------------------------------------------------------
// Where the application was made, for the Feed's Job Platform column. Job
// boards are recognised by sending domain; anything else that wrote back
// (ATS, careers page, recruiter) is the company's own channel.
const JOB_BOARDS = [
  [/jobstreet/i, 'JobStreet'], [/linkedin/i, 'LinkedIn'], [/indeed/i, 'Indeed'],
  [/kalibrr/i, 'Kalibrr'], [/onlinejobs/i, 'OnlineJobs.ph'], [/torre\.ai/i, 'Torre'],
];
let jobPlatform = 'Company Website';
if (isSent) jobPlatform = 'Direct Email';
else for (const [re, name] of JOB_BOARDS) if (re.test(from)) { jobPlatform = name; break; }
const onJobBoard = JOB_BOARDS.some(([, name]) => name === jobPlatform);
// A board's display name ("Indeed Apply", "LinkedIn") is not the employer.
if (onJobBoard && !gotCompany) company = '';

// --- confidence and routing ----------------------------------------------
// A row is only trustworthy enough to land in the tracker when the email said
// something recognisable AND we know who sent it. Everything else goes to
// needs-review, where a human decides in ten seconds. The one exception: a job
// board confirmation (Indeed) that names the job but not the employer is still
// traceable, because the board itself identifies where the application lives.
const parsed = Boolean(status) && Boolean(title) && (Boolean(company) || onJobBoard);

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

const threadId = String(msg.threadId || '');
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

return {
  json: {
    message_id: String(msg.id || msg.messageId || ''),
    thread_id: threadId,
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
    job_platform: jobPlatform,
    // One Feed row per application: every email about the same job at the
    // same employer lands on the same key. Where the employer is unknown
    // (Indeed, or any board whose sentence-extractors missed the company),
    // the board stands in for the employer, and the Gmail thread id is
    // appended as a disambiguator — otherwise two different real employers
    // that share a board and a common title (e.g. two "Software Engineer"
    // applications via Indeed) would collapse onto the same Feed row and
    // silently blend each other's dates/status. This does NOT run when the
    // company is known: known-company applications must keep exactly
    // `company|title` so that later emails about the *same* application
    // (different thread, different received_at) still collapse onto the one
    // row the forward-merge (merge-feed.js) depends on. Trade-off: if a board
    // answers with a new Gmail thread instead of replying in the original
    // one, this produces a second, disconnected Feed row for what is really
    // the same application — accepted as a much safer failure mode than
    // silently merging two unrelated applications.
    application_key: company
      ? norm(company) + '|' + norm(title)
      : norm(jobPlatform) + '|' + norm(title) + (threadId ? '|' + threadId : ''),
    // The Gmail sub-label under "Job Application/". Anything routed to
    // needs-review is labelled that, whatever status was guessed.
    status_label: parsed ? (STATUS_LABELS[status] || 'Needs Review') : 'Needs Review',
    from_address: from,
    subject,
    parsed,
    confidence,
    // Subject + body, bounded, for the LLM fallback's prompt only. Never
    // written to Airtable (INBOX_FIELDS/REVIEW_FIELDS don't list it) and
    // never reaches dist/.
    raw_text: (subject + '\n\n' + body).slice(0, 4000),
  },
};
