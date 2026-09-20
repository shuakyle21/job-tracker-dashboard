// Body of the "Apply LLM Fallback" Code node (mode: runOnceForEachItem).
//
// This file is the source of truth. scripts/build-n8n.mjs inlines it into
// n8n/job-tracker-ingest.json, and scripts/verify.mjs fails the build if the
// two drift apart. Test it outside n8n with: node scripts/test-llm-fallback.mjs
//
// Contract: only reached when Parse Job Email's rules couldn't classify an
// email. Reads $json (the "Classify With LLM" HTTP Request node's response)
// and $('Parse Job Email').item.json (the original row), returns { json }
// in the exact same shape parse-email.js produces. It never throws — a
// malformed LLM reply, an unrecognized status, or an n8n error-passthrough
// object all fall through to the original, unchanged parsed:false row rather
// than guess. An LLM success can only improve a row, never regress one: it
// is capped at confidence:'medium' (never 'high', since it's inferred, not
// pattern-matched) and it never overrides an already-parsed row.

const original = $('Parse Job Email').item.json;

// Mirrors n8n/parse-email.js's STATUS_LABELS exactly — scripts/verify.mjs
// checks the two stay in sync.
const STATUS_LABELS = {
  'applied': 'Applied', 'viewed by employer': 'Viewed', 'in review': 'In Review',
  'assessment': 'Assessment', 'interview scheduled': 'Interview', 'offer': 'Offer',
  'rejected': 'Rejected', 'talent pool': 'Talent Pool',
};

let status = original.status;
let status_label = original.status_label;
let parsed = original.parsed;
let confidence = original.confidence;

if (!parsed) {
  try {
    const guess = JSON.parse($json?.choices?.[0]?.message?.content ?? '');
    const candidate = String(guess?.status || '').toLowerCase().trim();
    // A board's own confirmation is traceable even without a named employer
    // (Indeed) — same bar parse-email.js uses for `parsed`.
    const onJobBoard = !['Company Website', 'Direct Email'].includes(original.job_platform);
    if (Object.prototype.hasOwnProperty.call(STATUS_LABELS, candidate)
        && original.job_title && (original.company || onJobBoard)) {
      status = candidate;
      status_label = STATUS_LABELS[status];
      parsed = true;
      confidence = 'medium';
    }
  } catch {
    // Malformed LLM output, an n8n error-passthrough object (onError:
    // continueRegularOutput), or an unrecognized status — leave the
    // rule-based result untouched rather than guess.
  }
}

return { json: { ...original, status, status_label, parsed, confidence } };
