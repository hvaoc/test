#!/usr/bin/env bash
# Run the WHOLE Maestro suite in ONE session (one app launch + clearState, paid once),
# then emit a per-CASE JSON result file that lines up 1:1 with the web Playwright cases.
#
# How the speed win works: `maestro test <folder>` runs every flow sequentially against
# the SAME running app. Only 00-setup.yaml calls launchApp/clearState; every case flow
# after it has no launchApp, so Maestro attaches to the already-open app (no relaunch,
# no re-hydration). The ~60s cold start is paid once for the entire suite instead of
# once per test.
#
# Granularity: each case flow == one web test case (see .maestro/cases.json, which maps
# each flow to the exact web {file,title}). We ask Maestro for JUnit output and join it
# against the manifest so the report shows the same 21 rows for mobile as for web.
#
#   ./scripts/maestro-report.sh ios      docs/test-results/maestro-ios.json      <udid>
#   ./scripts/maestro-report.sh android  docs/test-results/maestro-android.json  emulator-5554
set -uo pipefail
source "$(dirname "$0")/mobile-env.sh"
PLATFORM="${1:?platform (ios|android)}"
OUT="${2:?output json path}"
DEVICE="${3:-}"   # explicit device (udid / emulator-5554) — REQUIRED when both are up
MAESTRO="$HOME/.maestro/bin/maestro"
# Run the WORKSPACE (dir containing config.yaml), NOT flows/ directly — the config's
# executionOrder is what forces sequential single-session execution (see config.yaml).
WORKSPACE="$ROOT/.maestro"
MANIFEST="$ROOT/.maestro/cases.json"
JUNIT="$(mktemp -t maestro-junit).xml"
DEV_ARG=(); [ -n "$DEVICE" ] && DEV_ARG=(--device "$DEVICE")

echo "── running the full $PLATFORM suite in one session ──"
# One invocation → one app launch. Continues through all flows even if some fail.
"$MAESTRO" "${DEV_ARG[@]}" test --format junit --output "$JUNIT" "$WORKSPACE" 2>&1 | tail -40
echo "── suite finished; building per-case JSON ──"

PLATFORM="$PLATFORM" JUNIT="$JUNIT" MANIFEST="$MANIFEST" OUT="$OUT" node <<'NODE'
const fs = require('fs');
const { PLATFORM, JUNIT, MANIFEST, OUT } = process.env;

// Parse the JUnit XML into name -> {status, ms}. Regex is enough for Maestro's flat output.
const xml = fs.existsSync(JUNIT) ? fs.readFileSync(JUNIT, 'utf8') : '';
const byFlow = {};
for (const m of xml.matchAll(/<testcase\b[^>]*\/?>/g)) {
  const tag = m[0];
  const name = (tag.match(/\bname="([^"]*)"/) || [])[1];
  const time = parseFloat((tag.match(/\btime="([^"]*)"/) || [])[1] || '0');
  const status = (tag.match(/\bstatus="([^"]*)"/) || [])[1] || '';
  if (name) byFlow[name] = { status, ms: Math.round(time * 1000) };
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const cases = manifest.cases.map((c) => {
  if (!c.flow) return { file: c.file, title: c.title, status: 'na', reason: c.na || 'not run on mobile' };
  const r = byFlow[c.flow];
  if (!r) return { file: c.file, title: c.title, status: 'fail', reason: 'flow did not run (suite aborted before reaching it)' };
  const status = /SUCCESS/i.test(r.status) ? 'pass' : 'fail';
  return { file: c.file, title: c.title, status, durationMs: r.ms };
});

const out = { platform: PLATFORM, setup: byFlow['00-setup'] ? { durationMs: byFlow['00-setup'].ms } : null, cases };
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
const pass = cases.filter((c) => c.status === 'pass').length;
const fail = cases.filter((c) => c.status === 'fail').length;
const na = cases.filter((c) => c.status === 'na').length;
console.log(`wrote ${OUT}: ${pass} pass · ${fail} fail · ${na} n/a  (of ${cases.length} canonical cases)`);
NODE
