// Body of the "Apply LLM Fallback" Code node (mode: runOnceForEachItem).
//
// This file is the source of truth. scripts/build-n8n.mjs inlines it into
// n8n/job-tracker-ingest.json, and scripts/verify.mjs fails the build if the
// two drift apart. Test it outside n8n with: node scripts/test-llm-fallback.mjs
//
// Contract: only reached when Parse Job Email's rules couldn't classify an
// email. Reads $json (the classifier node's reply) and
// $('Parse Job Email').item.json (the original row), returns { json } in the
// exact same shape parse-email.js produces. scripts/build-n8n.mjs generates
// "Classify With LLM" as a Message an Agent node, so the reply is
// { structuredOutput, text }. OpenAI's { choices[0].message.content } is
// still read, so going back to a plain HTTP Request node needs no change here.
// Change the node in build-n8n.mjs, never by hand in the n8n UI:
// check-live.mjs flags any live node that differs from the generated JSON.
//
// It never throws — a malformed reply, an unrecognized status, or an
// n8n error-passthrough object all fall through to the original, unchanged
// parsed:false row rather than guess. An LLM success can only improve a row,
// never regress one: it is capped at confidence:'medium' (never 'high', since
// it's inferred, not pattern-matched) and it never overrides an already-parsed
// row.

const original = $('Parse Job Email').item.json;

// Mirrors n8n/parse-email.js's STATUS_LABELS exactly — scripts/verify.mjs
// checks the two stay in sync.
const STATUS_LABELS = {
  'applied': 'Applied', 'viewed by employer': 'Viewed', 'in review': 'In Review',
  'assessment': 'Assessment', 'interview scheduled': 'Interview', 'offer': 'Offer',
  'rejected': 'Rejected', 'talent pool': 'Talent Pool',
};

// Mirrors parse-email.js's STAGE_OF_STATUS, also checked by verify.mjs. The
// status is the only stage evidence taken from the model: an "offer" is
// stage 5, and the model can't claim more than its status implies.
const STAGE_OF_STATUS = {
  'applied': 1, 'no response': 1, 'closed / expired': 1, 'rejected': 1,
  'viewed by employer': 2, 'in review': 2, 'talent pool': 2,
  'assessment': 3, 'interview scheduled': 4, 'interviewed': 4, 'offer': 5,
};

let status = original.status;
let status_label = original.status_label;
let parsed = original.parsed;
let confidence = original.confidence;
let company = original.company;
let job_title = original.job_title;
let application_key = original.application_key;
let max_stage = original.max_stage;

// Same normalization as parse-email.js, so an agent-filled key lands on the
// row a later rule-parsed email about the same job will target.
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').replace(/ ?\| ?/g, '|').trim();
// Matches a board's display names too ("Indeed Apply", "LinkedIn Jobs").
const BOARD = /^(?:linkedin|indeed|jobstreet|kalibrr|onlinejobs(?:\.ph)?|torre)\b/i;

if (!parsed) {
  try {
    // structuredOutput is null when the agent node's output format wasn't
    // enforced, so its JSON may still be in text.
    const guess = $json?.structuredOutput && typeof $json.structuredOutput === 'object'
      ? $json.structuredOutput
      : JSON.parse($json?.text || $json?.choices?.[0]?.message?.content || '');
    const candidate = String(guess?.status || '').toLowerCase().trim();

    // Accept a company or title only if the email literally contains it, and
    // keep the email's own spelling so the key matches future emails. A guessed
    // employer would build a Feed key no later email can match.
    const hay = String((original.subject || '') + '\n' + (original.raw_text || ''));
    const shown = (v) => {
      const s = String(v || '').replace(/\s+/g, ' ').trim();
      if (!s || s.length >= 80) return '';
      const i = hay.toLowerCase().indexOf(s.toLowerCase());
      return i < 0 ? '' : hay.slice(i, i + s.length).replace(/\s+/g, ' ').trim();
    };

    company = original.company || shown(guess?.company);
    // A job board is never the employer, whatever the model says.
    if (BOARD.test(company)) company = original.company;
    job_title = original.job_title || shown(guess?.job_title);

    const key = norm(company) + '|' + norm(job_title);
    application_key = key.split('|').every(Boolean) ? key : '';

    // Same bar parse-email.js uses for `parsed`: a recognizable status and a
    // complete company|title key. Without both, the row stays at Needs Review.
    if (Object.prototype.hasOwnProperty.call(STATUS_LABELS, candidate) && application_key) {
      status = candidate;
      status_label = STATUS_LABELS[status];
      parsed = true;
      confidence = 'medium';
      // The model's own max_stage is ignored. merge-feed.js never lowers a
      // stage, so a wrong high guess would inflate the funnel for good.
      max_stage = Math.max(Number(original.max_stage) || 1, STAGE_OF_STATUS[status] || 1);
    }
  } catch {
    // Malformed LLM output, an n8n error-passthrough object (onError:
    // continueRegularOutput), or an unrecognized status — leave the
    // rule-based result untouched rather than guess.
  }
}

return {
  json: { ...original, status, status_label, parsed, confidence, company, job_title, application_key, max_stage },
};
