// Browser regression fixture: every time on the board in the viewer's zone, with
// the zone named (agentwatch board age-65t), on a phone-sized screen. Every
// project request and the zone URL (meta.viewerZoneUrl) are intercepted; this
// never reaches a Beads database. Run against a dev or production server:
//   SCOTTY_TEST_URL=http://localhost:3000[/board] [SCOTTY_TEST_SHOT=path.png] node scripts/test-viewer-zone-ui.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to the running demo server");

const ZONE_URL = "/api/viewer/zone";
const BUENOS_AIRES = { s: "ok", data: { zone: "America/Argentina/Buenos_Aires", source: "location", letters: ["ART"],
  labels: [{ utc_offset_seconds: -10800, letters: "ART" }] } };
const NO_ZONE = { s: "ok", data: { zone: null, source: null, letters: [], labels: [] } };

const bead = (id, title, extra = {}) => ({
  id, title, status: "open", issue_type: "task", priority: 2, labels: [], dependencies: [],
  created_at: "2026-11-12T18:30:00Z", updated_at: "2026-11-12T19:00:00Z", ...extra,
});
// Created 15:30, updated 16:00, closed 16:20, a comment at 15:45 (Buenos Aires); a question updated 16:00.
const beads = [
  bead("zone-1", "A closed item", {
    status: "closed", closed_at: "2026-11-12T19:20:00Z", created_by: "agent:aw-lead",
    comments: [{ id: "c1", author: "agent:aw-lead", text: "Done; checked at 15:40 ART as typed.", created_at: "2026-11-12T18:45:00Z" }],
  }),
  bead("ask-1", "A question for you", { labels: ["human", "question"], description: "Pick one." }),
];

const browser = await chromium.launch({ executablePath: process.env.SCOTTY_BROWSER_EXECUTABLE || undefined });
const errors = [];
let zoneAnswer = BUENOS_AIRES;
let zoneUrl = ZONE_URL;
const asked = [];

async function phone() {
  // The browser is in New York: the host's zone must win over it.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
    isMobile: true, timezoneId: "America/New_York", locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/viewer-mode", (route) => route.fulfill({ json: { readOnly: true } }));
  await page.route("**/api/p/demo/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (path.endsWith("/beads")) {
      return route.fulfill({ json: { beads, meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"],
        pollIntervalMs: 300000, viewerZoneUrl: zoneUrl } } });
    }
    return route.fulfill({ json: {} });
  });
  await page.route(`**${ZONE_URL}`, (route) => {
    asked.push(route.request().method());
    return route.fulfill({ json: zoneAnswer });
  });
  return { context, page };
}

async function drawerTimes(page) {
  await page.goto(`${base}/p/demo?bead=zone-1`);
  const dialog = page.getByRole("dialog");
  await dialog.getByText("A closed item", { exact: true }).waitFor();
  const activity = dialog.locator("span.font-mono.text-\\[11px\\]");
  await activity.first().waitFor();
  return { dialog, times: await activity.allTextContents() };
}

try {
  // 1. The host names Buenos Aires: every time is in ART, named; the browser's New York zone is not used.
  {
    const { context, page } = await phone();
    const { dialog } = await drawerTimes(page);
    await dialog.getByText("Nov 12, 2026, 15:30 ART").waitFor();
    const { times } = await drawerTimes(page);
    assert.deepEqual(times.filter((t) => /\d{2}:\d{2}/.test(t)),
      ["Nov 12, 2026, 15:30 ART", "Nov 12, 2026, 16:00 ART", "Nov 12, 2026, 16:20 ART"], "created, updated, closed");
    const commentTitle = await dialog.locator("span[title]", { hasText: "ago" }).first().getAttribute("title");
    assert.equal(commentTitle, "Nov 12, 2026, 15:45 ART", "a comment's time");
    assert.ok(await dialog.getByText("Done; checked at 15:40 ART as typed.").isVisible(), "typed text stays as typed");
    const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(width.scroll, width.client, "the page does not scroll sideways at 390 px");
    if (process.env.SCOTTY_TEST_SHOT) {
      await dialog.getByText("Nov 12, 2026, 15:30 ART").scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.SCOTTY_TEST_SHOT });
    }

    // The inbox (Needs You): the question's time.
    await page.goto(`${base}/p/demo?view=needsyou`);
    const card = page.locator("span[title]", { hasText: "ago" }).first();
    await page.locator('span[title="Nov 12, 2026, 16:00 ART"]').first().waitFor();
    assert.equal(await card.getAttribute("title"), "Nov 12, 2026, 16:00 ART");
    assert.ok(asked.length >= 1 && asked.every((m) => m === "GET"), "the zone URL is only read");
    await context.close();
  }

  // 2. The host knows no zone: the browser's own zone and its short name.
  {
    zoneAnswer = NO_ZONE;
    const { context, page } = await phone();
    const { dialog } = await drawerTimes(page);
    await dialog.getByText("Nov 12, 2026, 13:30 EST").waitFor();
    await context.close();
  }

  // 3. No zone URL (Scotty without agentwatch): the browser's zone, and no zone request.
  {
    zoneAnswer = BUENOS_AIRES;
    zoneUrl = null;
    asked.length = 0;
    const { context, page } = await phone();
    const { dialog } = await drawerTimes(page);
    await dialog.getByText("Nov 12, 2026, 14:20 EST").waitFor();
    assert.deepEqual(asked, [], "no zone request without a URL");
    await context.close();
  }

  assert.deepEqual(errors, []);
  console.log("PASS: viewer zone at 390x844: the host's zone named (ART) in the drawer, a comment and Needs You;"
    + " typed text stays; a null zone or no URL uses the browser's zone (EST)");
} finally {
  await browser.close();
}
