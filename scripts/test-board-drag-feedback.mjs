// Board cross-column drag feedback. Uses only intercepted demo fixtures; no project data is read or written.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");

const bead = (id, status) => ({
  id,
  title: `Feedback ${id}`,
  status,
  issue_type: "task",
  priority: 2,
  labels: [],
  dependencies: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
});

const beads = [
  bead("mover", "open"),
  bead("ready-peer", "open"),
  // A long source column: its lower cards sit level with the pointer when dropping low in a shorter column.
  ...Array.from({ length: 8 }, (_, i) => bead(`filler-${i + 1}`, "open")),
  bead("busy-a", "in_progress"),
  bead("busy-b", "in_progress"),
];
const writes = [];

const browser = await chromium.launch();
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/api/p/demo/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (path.endsWith("/order")) {
      if (request.method() === "GET") return route.fulfill({ json: { orders: {} } });
      writes.push({ kind: "order", body: request.postDataJSON() });
      return route.fulfill({ json: { orders: {} } });
    }
    if (path.endsWith("/beads")) return route.fulfill({ json: { beads, meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300000 } } });
    if (path.endsWith("/status")) {
      const body = request.postDataJSON();
      const id = path.split("/").at(-2);
      const target = beads.find((candidate) => candidate.id === id);
      if (target) target.status = body.status;
      writes.push({ kind: "status", id, body });
      return route.fulfill({ json: target ?? {} });
    }
    return route.fulfill({ json: beads.find((candidate) => path.endsWith(`/beads/${candidate.id}`)) ?? {} });
  });

  const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
  const column = (name) => page.getByText(name, { exact: true }).locator("xpath=ancestor::section[1]");
  // The drop zone is the element that holds a column's cards.
  const zoneHighlighted = (name) =>
    column(name).locator("article").first().locator("xpath=..").evaluate((zone) => getComputedStyle(zone).outlineStyle === "dashed");
  const center = async (locator) => {
    const box = await locator.boundingBox();
    assert.ok(box, "drag targets must be visible");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const pickUp = async (id) => {
    const from = await center(card(id));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
  };
  const hoverCard = async (id) => {
    const to = await center(card(id));
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.waitForTimeout(150);
    return to;
  };
  const previewUnderPointer = (point, title) =>
    page.evaluate(({ x, y, text }) =>
      document.elementsFromPoint(x, y).some((element) => element.closest("article")?.textContent?.includes(text)), { ...point, text: title });

  await page.goto(`${base}/p/demo`);
  await page.getByRole("heading", { name: "Board", exact: true }).waitFor();
  const unlock = await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
  assert.equal(unlock.status(), 200, "isolated demo can be unlocked for mutation assertions");
  await page.reload();
  await card("mover").waitFor();

  // Hovering a card in another column is the common case: the preview must travel with the pointer
  // and the column under it must advertise itself as the drop target.
  await pickUp("mover");
  const overBusy = await hoverCard("busy-a");
  assert.equal(await page.locator('article[aria-hidden="true"] button').count(), 0, "the preview has no hidden focusable copy button");
  assert.ok(await previewUnderPointer(overBusy, "Feedback mover"), "a preview of the dragged card follows the pointer into another column");
  assert.equal(await zoneHighlighted("In Progress"), true, "the column under the pointer is highlighted while hovering one of its cards");
  assert.equal(await zoneHighlighted("Ready"), false, "the source column is not highlighted as a drop target");

  const statusWrite = page.waitForResponse((response) => response.url().endsWith("/beads/mover/status") && response.request().method() === "POST");
  await page.mouse.up();
  await statusWrite;
  assert.deepEqual(writes.map((write) => write.kind), ["status"], "dropping on another column's card writes status only");
  assert.equal(writes.at(-1).body.status, "in_progress");
  await card("mover").locator("xpath=ancestor::section[1]").getByText("In Progress", { exact: true }).waitFor();
  assert.equal(await zoneHighlighted("In Progress"), false, "the highlight clears after a drop");

  // Escape cancels a drag without writing, and clears both the preview and the highlight.
  const cancelWrites = writes.length;
  await pickUp("ready-peer");
  const overPeer = await hoverCard("busy-b");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(250);
  assert.equal(writes.length, cancelWrites, "a cancelled drag writes nothing");
  assert.equal(await previewUnderPointer(overPeer, "Feedback ready-peer"), false, "the preview is removed when a drag is cancelled");
  assert.equal(await zoneHighlighted("In Progress"), false, "the highlight clears when a drag is cancelled");

  // The column under the pointer is the target, even in its empty space and even when a long source
  // column has cards closer to the dragged card's corners.
  const emptySpaceWrites = writes.length;
  await pickUp("ready-peer");
  const zone = await column("In Progress").locator("article").first().locator("xpath=..").boundingBox();
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height - 30, { steps: 12 });
  await page.waitForTimeout(150);
  assert.equal(await zoneHighlighted("In Progress"), true, "empty space low in another column is highlighted as the drop target");
  const emptySpaceStatus = page.waitForResponse((response) => response.url().endsWith("/beads/ready-peer/status") && response.request().method() === "POST");
  await page.mouse.up();
  await emptySpaceStatus;
  assert.deepEqual(writes.slice(emptySpaceWrites).map((write) => write.kind), ["status"], "dropping into another column's empty space writes status only");
  assert.equal(writes.at(-1).body.status, "in_progress");

  // Dependency-blocked open beads cannot become Ready through a no-op status write.
  beads.push({ ...bead("blocked-open", "open"), dependencies: [{ depends_on_id: "filler-1", type: "blocks" }] });
  await page.reload();
  await card("blocked-open").waitFor();
  const blockedWrites = writes.length;
  await pickUp("blocked-open");
  await hoverCard("filler-1");
  assert.equal(await zoneHighlighted("Ready"), false, "a no-op status destination must not advertise a move");
  await page.mouse.up();
  await page.waitForTimeout(250);
  assert.equal(writes.length, blockedWrites, "a dependency-blocked bead cannot be unblocked by setting open again");

  assert.deepEqual(errors, []);
  console.log("PASS: cross-column drag shows a travelling preview and target highlight, still writes status on drop, and cancels cleanly");
} catch (error) {
  console.error({ writes, url: page?.url() });
  throw error;
} finally {
  await browser.close();
}
