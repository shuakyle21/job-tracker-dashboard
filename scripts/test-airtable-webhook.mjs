#!/usr/bin/env node
/**
 * Runs n8n/airtable-webhook.js outside n8n. Like the other test-*.mjs files, it
 * wraps the Code node body in a Function with the free variable n8n provides
 * ($json), so what passes here is exactly what runs there.
 *
 *   node scripts/test-airtable-webhook.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const source = await readFile(join(ROOT, "n8n/airtable-webhook.js"), "utf8");
// eslint-disable-next-line no-new-func
const decide = (listResponse) => new Function("$json", source)(listResponse).json;

const URL_OURS = source.match(/const NOTIFICATION_URL = '([^']+)'/)[1];
const inDays = (d) => new Date(Date.now() + d * 86400e3).toISOString();

let failures = 0;
function expect(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`  ok    ${label}`);
  else {
    console.error(`  FAIL  ${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
    failures++;
  }
}

const hook = (over = {}) => ({
  id: "achOURS", notificationUrl: URL_OURS, isHookEnabled: true,
  areNotificationsEnabled: true, expirationTime: inDays(5), ...over,
});

console.log("Airtable webhook keep-alive tests\n");

{
  const got = decide({ webhooks: [] });
  expect("no webhooks → create", got.action, "create");
  expect("create body points at the receiver", got.createBody.notificationUrl, URL_OURS);
  expect("create body is scoped to the Feed table",
    got.createBody.specification.options.filters, { dataTypes: ["tableData"], recordChangeScope: "tblPZSpJ8P4iFuAhX" });
}

{
  const got = decide({ webhooks: [hook()] });
  expect("healthy webhook → refresh", [got.action, got.webhookId], ["refresh", "achOURS"]);
  expect("healthy webhook has no leftovers", got.others, []);
}

{
  const got = decide({ webhooks: [hook({ areNotificationsEnabled: false })] });
  expect("notifications switched off → enable", [got.action, got.webhookId], ["enable", "achOURS"]);
}

{
  const got = decide({ webhooks: [hook({ expirationTime: inDays(-1) })] });
  expect("expired webhook → create a new one", got.action, "create");
  expect("expired webhook is reported", got.others, ["achOURS"]);
}

{
  const got = decide({ webhooks: [hook({ isHookEnabled: false })] });
  expect("disabled webhook → create a new one", got.action, "create");
}

{
  const got = decide({ webhooks: [hook({ expirationTime: null })] });
  expect("no expiry → refresh", got.action, "refresh");
}

{
  const got = decide({ webhooks: [hook({ expirationTime: "next tuesday" })] });
  expect("unreadable expiry → refresh, not a duplicate", got.action, "refresh");
}

{
  const got = decide({ webhooks: [
    hook({ id: "achOLD", expirationTime: inDays(1) }),
    hook({ id: "achNEW", expirationTime: inDays(6) }),
  ] });
  expect("duplicates → refresh the newest", [got.action, got.webhookId], ["refresh", "achNEW"]);
  expect("duplicates → report the rest", got.others, ["achOLD"]);
}

{
  const got = decide({ webhooks: [hook({ id: "achOTHER", notificationUrl: "https://example.com/hook" })] });
  expect("someone else's webhook is ignored", [got.action, got.others], ["create", []]);
}

for (const [label, input] of [["missing array", {}], ["null", null], ["error object", { error: { type: "INVALID_PERMISSIONS" } }]]) {
  let threw = false;
  try { decide(input); } catch { threw = true; }
  expect(`malformed response (${label}) fails loudly`, threw, true);
}

console.log(failures ? `\n${failures} check(s) failed\n` : "\nAll webhook keep-alive checks passed\n");
process.exit(failures ? 1 : 0);
