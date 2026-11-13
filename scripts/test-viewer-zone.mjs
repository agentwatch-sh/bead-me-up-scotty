// Pure tests of the viewer's zone (lib/viewer-zone.ts, agentwatch board age-65t):
// every time on the board in the viewer's zone, with the zone named. No server:
//   node scripts/test-viewer-zone.mjs   (Node 22.18+ for native TypeScript)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  NO_ZONE, browserZone, dayKey, formatClock, formatDateTime, loadViewerZone, normalizeZone, offsetLabel,
  sameOriginPath, setViewerZone, shownZone, subscribeViewerZone, toDate, viewerZone, withFallback, zoneLetters,
  zoneOffsetSeconds,
} from "../lib/viewer-zone.ts";

// The host's answers, as agentwatch's GET /api/viewer/zone gives them.
const BA = normalizeZone({ zone: "America/Argentina/Buenos_Aires", source: "location", letters: ["ART"],
  labels: [{ utc_offset_seconds: -10800, letters: "ART" }] });
const NY = normalizeZone({ zone: "America/New_York", letters: ["EST", "EDT"],
  labels: [{ utc_offset_seconds: -18000, letters: "EST" }, { utc_offset_seconds: -14400, letters: "EDT" }] });
const DUBAI = normalizeZone({ zone: "Asia/Dubai", labels: [{ utc_offset_seconds: 14400, letters: "UTC+4" }] });

const NOV = "2026-11-12T18:30:05Z";          // 15:30 in Buenos Aires
const JULY = "2026-07-01T16:00:00Z";         // 12:00 EDT
const JANUARY = "2026-01-15T17:00:00Z";      // 12:00 EST

// Buenos Aires -> ART.
assert.equal(formatDateTime(NOV, BA), "Nov 12, 2026, 15:30 ART");
assert.equal(formatDateTime(NOV, BA, { year: false }), "Nov 12, 15:30 ART");
assert.equal(formatClock(NOV, BA), "15:30 ART");

// A zone with summer time, in summer and in winter.
assert.equal(formatClock(JULY, NY), "12:00 EDT");
assert.equal(formatClock(JANUARY, NY), "12:00 EST");

// A zone with no letters: its offset, as agentwatch writes it; no labels: the browser's short name.
assert.equal(formatClock(NOV, DUBAI), "22:30 UTC+4");
assert.equal(formatClock(NOV, normalizeZone({ zone: "America/Argentina/Buenos_Aires" })), "15:30 UTC-3");
assert.equal(offsetLabel(20700), "UTC+5:45");

// UTC input strings and epoch numbers name the same moment.
const seconds = Date.UTC(2026, 10, 12, 18, 30, 5) / 1000;
for (const value of [NOV, "2026-11-12T18:30:05.000+00:00", "2026-11-12 18:30:05Z", "2026-11-12T18:30:05",
  "2026-11-12T15:30:05-03:00", seconds, seconds * 1000, String(seconds), new Date(seconds * 1000)]) {
  assert.equal(formatDateTime(value, BA), "Nov 12, 2026, 15:30 ART", String(value));
}
for (const bad of [null, undefined, "", 0, -1, "soon", Number.NaN, {}]) {
  assert.equal(toDate(bad), null, String(bad));
  assert.equal(formatDateTime(bad, BA), "");
}

// A calendar day with no time is no moment: as UTC midnight it reads a day early west of UTC.
for (const day of ["2026-11-12", " 2026-11-12 "]) {
  assert.equal(toDate(day), null, day);
  assert.equal(formatDateTime(day, BA), "");
  assert.equal(dayKey(day, BA), "");
}
assert.equal(dayKey("2026-11-12T12:00:00Z", BA), "2026-11-12");

// The calendar day is the zone's: 01:00 UTC on Nov 13 is still Nov 12 in Buenos Aires.
assert.equal(dayKey("2026-11-13T01:00:00Z", BA), "2026-11-12");

// A null zone -> the browser's zone and its short name.
assert.equal(shownZone(NO_ZONE), browserZone());
assert.equal(formatDateTime(NOV, NO_ZONE), formatDateTime(NOV, normalizeZone({ zone: browserZone() })));
const zoneModule = new URL("../lib/viewer-zone.ts", import.meta.url).href;
const inNewYork = execFileSync(process.execPath, ["--input-type=module", "-e",
  `import { formatClock, NO_ZONE } from ${JSON.stringify(zoneModule)};
   process.stdout.write([formatClock(${JSON.stringify(JULY)}, NO_ZONE), formatClock(${JSON.stringify(JANUARY)}, NO_ZONE)].join("|"));`],
  { env: { ...process.env, TZ: "America/New_York" } }).toString();
assert.equal(inNewYork, "12:00 EDT|12:00 EST");

// An answer the browser cannot use is no zone; odd labels are dropped.
assert.equal(normalizeZone(null), NO_ZONE);
assert.equal(normalizeZone({ zone: "Mars/Olympus" }), NO_ZONE);
assert.deepEqual(normalizeZone({ zone: "UTC", labels: [{ utc_offset_seconds: 0, letters: "<b>" },
  { utc_offset_seconds: 0, letters: "UTC" }] }).labels, [{ offset: 0, letters: "UTC" }]);

// The store: a change calls each subscriber once, the same zone none; the default zone is the store's.
{
  const seen = [];
  const stop = subscribeViewerZone(() => seen.push(viewerZone().zone));
  assert.equal(setViewerZone({ zone: "America/Argentina/Buenos_Aires", labels: [{ utc_offset_seconds: -10800, letters: "ART" }] }), true);
  assert.equal(setViewerZone({ zone: "America/Argentina/Buenos_Aires", labels: [{ utc_offset_seconds: -10800, letters: "ART" }] }), false);
  assert.equal(zoneLetters(NOV), "ART");
  assert.equal(formatDateTime(NOV), "Nov 12, 2026, 15:30 ART");
  stop();
  setViewerZone(null);
  assert.deepEqual(seen, ["America/Argentina/Buenos_Aires"]);
}

// The read: the host's envelope ({s, data}); a failed read keeps the zone (a trip changes it).
{
  const answer = (data, ok = true) => async () => ({ ok, json: async () => ({ s: "ok", data }) });
  const asked = [];
  const recording = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => ({ s: "ok", data: { zone: "Europe/Madrid", labels: [] } }) };
  };
  assert.equal(await loadViewerZone("/api/viewer/zone", recording), true);
  assert.deepEqual(asked, [`/api/viewer/zone?fallback=${encodeURIComponent(browserZone())}`], "the browser's zone is sent");
  setViewerZone(null);
  assert.equal(await loadViewerZone("/api/viewer/zone", answer({ zone: "Europe/Madrid", labels: [] })), true);
  assert.equal(viewerZone().zone, "Europe/Madrid");
  assert.equal(await loadViewerZone("/api/viewer/zone", answer(null, false)), false);
  assert.equal(await loadViewerZone("/api/viewer/zone", async () => { throw new Error("offline"); }), false);
  assert.equal(viewerZone().zone, "Europe/Madrid");
  assert.equal(await loadViewerZone("/api/viewer/zone", answer({ zone: null, labels: [] })), true);
  assert.equal(viewerZone(), NO_ZONE);
}

// The browser's zone as the fallback: the URL keeps its own query.
assert.equal(withFallback("/api/viewer/zone", "America/Buenos_Aires"), "/api/viewer/zone?fallback=America%2FBuenos_Aires");
assert.equal(withFallback("/z?a=1", "UTC"), "/z?a=1&fallback=UTC");
assert.equal(withFallback("/api/viewer/zone", "Mars/Olympus"), "/api/viewer/zone");

// A null zone with the host's letters for the browser's zone: Buenos Aires is ART, never UTC-3.
const BROWSER_BA = { zone: null, source: "browser", letters: ["ART"], labels: [{ utc_offset_seconds: -10800, letters: "ART" }] };
const inBuenosAires = (tz) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
  `import { formatClock, formatDateTime, loadViewerZone, viewerZone } from ${JSON.stringify(zoneModule)};
   const asked = [];
   const before = formatClock(${JSON.stringify(NOV)});
   await loadViewerZone("/api/viewer/zone", async (url) => { asked.push(url);
     return { ok: true, json: async () => ({ s: "ok", data: ${JSON.stringify(BROWSER_BA)} }) }; });
   process.stdout.write(JSON.stringify({ before, after: formatClock(${JSON.stringify(NOV)}),
     full: formatDateTime(${JSON.stringify(NOV)}), asked, info: viewerZone() }));`],
  { env: { ...process.env, TZ: tz } }).toString());
for (const tz of ["America/Argentina/Buenos_Aires", "America/Buenos_Aires"]) {
  const out = inBuenosAires(tz);
  assert.equal(out.before, "15:30 UTC-3", "without the host, the browser says GMT-3");
  assert.equal(out.after, "15:30 ART", tz);
  assert.equal(out.full, "Nov 12, 2026, 15:30 ART");
  assert.equal(out.info.zone, null);
  assert.match(out.asked[0], /^\/api\/viewer\/zone\?fallback=America%2F/);
}

// The host's letters for a browser zone apply to that zone only.
{
  const mine = browserZone();
  const other = mine === "Asia/Dubai" ? "Asia/Tokyo" : "Asia/Dubai";
  const offset = zoneOffsetSeconds(new Date(NOV), mine);
  const labels = [{ utc_offset_seconds: offset, letters: "XYZ" }];
  assert.notEqual(zoneLetters(NOV, normalizeZone({ ...BROWSER_BA, labels, fallback: other })), "XYZ");
  assert.equal(zoneLetters(NOV, normalizeZone({ ...BROWSER_BA, labels, fallback: mine })), "XYZ");
  assert.equal(normalizeZone({ ...BROWSER_BA, labels: [], fallback: mine }), NO_ZONE);
  assert.equal(normalizeZone({ ...BROWSER_BA, source: null, fallback: mine }), NO_ZONE);
  assert.equal(normalizeZone({ ...BROWSER_BA, fallback: "Mars/Olympus" }), NO_ZONE);
}

// Only a path on this origin is a zone URL.
assert.equal(sameOriginPath("/api/viewer/zone"), "/api/viewer/zone");
for (const bad of ["https://evil.example/zone", "//evil.example/zone", "/a\\b", "", null, 3]) {
  assert.equal(sameOriginPath(bad), null, String(bad));
}

console.log("PASS: viewer zone: ART, summer and winter letters, offsets, UTC strings and epochs, no date-only moment,"
  + " the browser's zone and its letters from the host (ART, never UTC-3), the store and the read");
