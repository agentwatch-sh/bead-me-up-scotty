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

  // The isolated server starts read-only, where cards do not drag, so nothing is revealed.
  await pickUp("ready-a");
  await page.waitForTimeout(150);
  assert.deepEqual(await shown(), ["ready", "done"], "read-only: pressing a card reveals nothing");
  await page.mouse.up();

  // While a card is dragged every droppable column shows, in order and at full width.
  // Blocked takes no drops, so it stays hidden.
  const unlock = await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
  assert.equal(unlock.status(), 200, "isolated demo can be unlocked for mutation assertions");
  await open();
  await card("ready-a").waitFor();
  const pointer = await pickUp("ready-a");
  await expectShown(["backlog", "ready", "in_progress", "done"], "a drag shows every droppable column, empty ones included");
  assert.deepEqual(await widths(), [296, 296, 296, 296]);
  // Waiting appears to the left and moves Ready, but the preview stays with the pointer.
  assert.ok(await previewUnderPointer(pointer, "ready-a"), "the drag preview stays under the pointer when a column appears to its left");
  const moved = { x: pointer.x + 40, y: pointer.y + 30 };
  await page.mouse.move(moved.x, moved.y, { steps: 4 });
  assert.ok(await previewUnderPointer(moved, "ready-a"), "the drag preview follows the pointer after the columns appear");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expectShown(["ready", "done"], "a cancelled drag hides the empty columns again");
  assert.deepEqual(writes, [], "a cancelled drag writes nothing");

  // A revealed empty column takes a drop; afterwards the rule applies again.
  await pickUp("ready-a");
  await expectShown(["backlog", "ready", "in_progress", "done"]);
  const empty = await page.locator('[data-board-column="in_progress"]').getByText("No beads", { exact: true }).boundingBox();
  assert.ok(empty, "the revealed In Progress column shows its empty state");
  await page.mouse.move(empty.x + empty.width / 2, empty.y + empty.height / 2, { steps: 12 });
  await page.waitForTimeout(150);
  const statusWrite = page.waitForResponse((response) => response.url().endsWith("/beads/ready-a/status") && response.request().method() === "POST");
  await page.mouse.up();
  await statusWrite;
  assert.deepEqual(writes, [{ id: "ready-a", body: { status: "in_progress" } }], "dropping into an empty In Progress writes in_progress");
  await page.locator('[data-board-column="in_progress"] [data-keyboard-bead-id="ready-a"]').waitFor();
  await expectShown(["ready", "in_progress", "done"], "after the drop only columns with cards show");
  beads.find((b) => b.id === "ready-a").status = "open";

  // Counts follow the filters: a search that matches nothing leaves every column empty, so all show.
  await open("?q=nothing-matches-this");
  await expectShown(["backlog", "ready", "blocked", "in_progress", "done"], "a board with no visible cards shows all five columns");

  // A board with no beads at all shows all five columns too.
  beads = [];
  await open();
  await expectShown(["backlog", "ready", "blocked", "in_progress", "done"], "an empty board shows all five columns");
  beads = readyAndDone;

  // A chosen Done window that empties Done keeps Done (and its window control) on screen.
  await open("?done=7");
  await card("ready-b").waitFor();
  await expectShown(["ready", "done"], "Done stays while a window is chosen, so the window can be changed back");
  assert.equal(await page.locator('[data-board-column="done"] article').count(), 0);
  assert.equal(await page.locator('[data-board-column="done"] select').inputValue(), "7");

  // A Blocked column pinned in Settings still shows when empty.
  await page.evaluate(() => localStorage.setItem("bmus.board", JSON.stringify({ blockedColumn: "always" })));
  await open();
  await card("ready-b").waitFor();
  await expectShown(["ready", "blocked", "done"], "a pinned Blocked column shows when empty");

  assert.deepEqual(errors, []);
  console.log("PASS: empty board columns hide, every droppable column shows during a drag and takes a drop, an empty board shows all columns, and the Done window and pinned Blocked column stay reachable");
} catch (error) {
  console.error({ writes, url: page?.url() });
  throw error;
} finally {
  await browser.close();
}
