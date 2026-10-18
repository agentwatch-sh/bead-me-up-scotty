// Board hides empty columns. Uses only intercepted demo fixtures; no project data is read or written.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");

const bead = (id, status, extra = {}) => ({
  id,
  title: `Empty columns ${id}`,
  status,
  issue_type: "task",
  priority: 2,
  labels: [],
  dependencies: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  ...extra,
});

// Only Ready and Done have cards.
const readyAndDone = [
  bead("ready-a", "open"),
  bead("ready-b", "open"),
  bead("done-a", "closed", { closed_at: "2026-09-02T00:00:00Z" }),
];
let beads = readyAndDone;
const writes = [];

const browser = await chromium.launch();
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/api/p/demo/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (path.endsWith("/order")) return route.fulfill({ json: { orders: {} } });
    if (path.endsWith("/beads")) return route.fulfill({ json: { beads, meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300000 } } });
    if (path.endsWith("/status")) {
      const body = request.postDataJSON();
      const id = path.split("/").at(-2);
      const target = beads.find((candidate) => candidate.id === id);
      if (target) target.status = body.status;
      writes.push({ id, body });
      return route.fulfill({ json: target ?? {} });
    }
    return route.fulfill({ json: beads.find((candidate) => path.endsWith(`/beads/${candidate.id}`)) ?? {} });
  });

  const card = (id) => page.locator(`[data-keyboard-bead-id="${id}"]`);
  const shown = () => page.locator("main [data-board-column]").evaluateAll((sections) => sections.map((s) => s.dataset.boardColumn));
  const widths = () => page.locator("main [data-board-column]").evaluateAll((sections) => sections.map((s) => s.getBoundingClientRect().width));
  // Position and size of every visible column, to prove a drag moves none of them.
  const boxes = () =>
    page.locator("main [data-board-column]").evaluateAll((sections) =>
      sections.map((s) => {
        const r = s.getBoundingClientRect();
        return { id: s.dataset.boardColumn, x: r.x, y: r.y, width: r.width, height: r.height };
      }));
  const bar = () => page.locator("[data-drop-bar]");
  const barTargets = () => page.locator("[data-drop-bar-target]").evaluateAll((targets) => targets.map((t) => t.dataset.dropBarTarget));
  const expectShown = async (ids, message) => {
    await page.waitForFunction(
      (wanted) => JSON.stringify([...document.querySelectorAll("main [data-board-column]")].map((s) => s.dataset.boardColumn)) === JSON.stringify(wanted),
      ids,
    ).catch(() => undefined);
    assert.deepEqual(await shown(), ids, message);
  };
  const pickUp = async (id) => {
    const box = await card(id).boundingBox();
    assert.ok(box, `${id} must be visible`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const pointer = { x: box.x + box.width / 2 + 8, y: box.y + box.height / 2 + 8 };
    await page.mouse.move(pointer.x, pointer.y, { steps: 2 });
    return pointer;
  };
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // The drag preview (the overlay copy of the card) sits under the pointer.
  const previewUnderPointer = (point, id) =>
    page.evaluate(({ x, y, title }) =>
      document.elementsFromPoint(x, y).some((el) => el.closest('article[aria-hidden="true"]')?.textContent?.includes(title)), { ...point, title: `Empty columns ${id}` });
  const open = async (query = "") => {
    await page.goto(`${base}/p/demo${query}`);
    await page.getByRole("heading", { name: "Board", exact: true }).waitFor();
    await page.locator("main [data-board-column]").first().waitFor();
  };

  await open();
  await card("done-a").waitFor();
  await expectShown(["ready", "done"], "only the columns with cards show");
  assert.deepEqual(await widths(), [296, 296], "visible columns keep their width");
  assert.equal(await bar().count(), 0, "no drop bar without a drag");

  // The isolated server starts read-only, where cards do not drag, so no bar appears.
  await pickUp("ready-a");
  await page.waitForTimeout(150);
  assert.equal(await bar().count(), 0, "read-only: pressing a card shows no drop bar");
  assert.deepEqual(await shown(), ["ready", "done"]);
  await page.mouse.up();

  const unlock = await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
  assert.equal(unlock.status(), 200, "isolated demo can be unlocked for mutation assertions");
  await open();
  await card("ready-a").waitFor();

  // While a card is dragged, the hidden columns that take a drop are offered in a bar
  // over the board. Blocked takes no drops and Done is on screen, so the bar holds
  // Waiting and In Progress. Nothing on the board moves or resizes.
  const before = await boxes();
  const pointer = await pickUp("ready-a");
  await bar().waitFor();
  await settle();
  assert.deepEqual(await boxes(), before, "the visible columns keep their positions and sizes during a drag");
  assert.deepEqual(await shown(), ["ready", "done"], "a drag puts no column back into the row");
  assert.deepEqual(await barTargets(), ["backlog", "in_progress"], "one bar target per hidden droppable column, in column order");
  assert.deepEqual(await page.locator("[data-drop-bar-target]").allTextContents(), ["Waiting", "In Progress"]);
  for (const target of await page.locator("[data-drop-bar-target]").all()) {
    const r = await target.boundingBox();
    assert.ok(r.height >= 44 && r.width >= 44, `bar targets are large enough for touch: ${r.width}x${r.height}`);
  }
  const area = await page.locator("main [data-board-column]").first().locator("xpath=../../..").boundingBox();
  const barBox = await bar().boundingBox();
  assert.ok(Math.abs(barBox.y + barBox.height - (area.y + area.height)) <= 1, "the bar sits on the bottom edge of the board area");
  assert.ok(await previewUnderPointer(pointer, "ready-a"), "the drag preview stays under the pointer");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await bar().waitFor({ state: "detached" });
  assert.deepEqual(writes, [], "a cancelled drag writes nothing");
  assert.deepEqual(await boxes(), before);

  // A short drag released in place leaves the card where it was.
  await pickUp("ready-a");
  await bar().waitFor();
  await page.mouse.up();
  await bar().waitFor({ state: "detached" });
  await page.waitForTimeout(250);
  assert.deepEqual(writes, [], "a short drag released in place writes nothing");
  await page.locator('[data-board-column="ready"] [data-keyboard-bead-id="ready-a"]').waitFor();
  assert.deepEqual(await boxes(), before, "and the board is as it was");

  // A drop on a bar target counts as a drop on that column.
  await pickUp("ready-a");
  await bar().waitFor();
  const target = await page.locator('[data-drop-bar-target="in_progress"]').boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.waitForTimeout(150);
  const background = (id) => page.locator(`[data-drop-bar-target="${id}"]`).evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(await background("in_progress"), await background("backlog"), "the bar target under the pointer is highlighted");
  const statusWrite = page.waitForResponse((response) => response.url().endsWith("/beads/ready-a/status") && response.request().method() === "POST");
  await page.mouse.up();
  await statusWrite;
  assert.deepEqual(writes, [{ id: "ready-a", body: { status: "in_progress" } }], "a drop on the In Progress bar target writes in_progress");
  await page.locator('[data-board-column="in_progress"] [data-keyboard-bead-id="ready-a"]').waitFor();
  await expectShown(["ready", "in_progress", "done"], "the card's new column shows; the others stay hidden");
  assert.equal(await bar().count(), 0, "the bar goes away after the drop");
  beads.find((b) => b.id === "ready-a").status = "open";

  // With no hidden droppable column there is no bar (an empty Blocked takes no drops).
  beads = [...readyAndDone, bead("parked", "deferred"), bead("busy", "in_progress")];
  await open();
  await card("busy").waitFor();
  await expectShown(["backlog", "ready", "in_progress", "done"]);
  await pickUp("ready-a");
  await page.waitForTimeout(150);
  assert.equal(await bar().count(), 0, "no bar when every droppable column is on screen");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  beads = readyAndDone;

  // Counts follow the filters: a search that matches nothing leaves every column empty, so all show.
  await open("?q=nothing-matches-this");
  await expectShown(["backlog", "ready", "blocked", "in_progress", "done"], "a board with no visible cards shows all five columns");

  // A board with no beads at all shows all five columns too.
  beads = [];
  await open();
  await expectShown(["backlog", "ready", "blocked", "in_progress", "done"], "an empty board shows all five columns");
  beads = readyAndDone;

  // A chosen Done window that empties Done keeps Done (and its window control) on screen,
  // so Done is not hidden and gets no bar target.
  await open("?done=7");
  await card("ready-b").waitFor();
  await expectShown(["ready", "done"], "Done stays while a window is chosen, so the window can be changed back");
  assert.equal(await page.locator('[data-board-column="done"] article').count(), 0);
  assert.equal(await page.locator('[data-board-column="done"] select').inputValue(), "7");
  await pickUp("ready-b");
  await bar().waitFor();
  assert.deepEqual(await barTargets(), ["backlog", "in_progress"]);
  await page.keyboard.press("Escape");
  await page.mouse.up();

  // A Blocked column pinned in Settings still shows when empty.
  await page.evaluate(() => localStorage.setItem("bmus.board", JSON.stringify({ blockedColumn: "always" })));
  await open();
  await card("ready-b").waitFor();
  await expectShown(["ready", "blocked", "done"], "a pinned Blocked column shows when empty");

  assert.equal(writes.length, 1, "only the bar drop wrote");
  assert.deepEqual(errors, []);
  console.log("PASS: empty board columns hide; during a drag a drop bar offers the hidden droppable columns without moving the board, a bar drop changes the status, a short drag in place changes nothing; an empty board shows all columns; the Done window and pinned Blocked column stay reachable");
} catch (error) {
  console.error({ writes, url: page?.url() });
  throw error;
} finally {
  await browser.close();
}
