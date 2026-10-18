// Board hides empty columns; during a drag a drop bar over the column-header row
// offers the hidden ones. Uses only intercepted demo fixtures; no project data is
// read or written. Runs the drag checks with a mouse on a desktop-size page and
// with touch on an iPad-size page.
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
const blocks = (target) => ({ dependencies: [{ type: "blocks", depends_on_id: target }] });

// Only Ready and Done have cards.
const readyAndDone = () => [
  bead("ready-a", "open"),
  bead("ready-b", "open"),
  bead("done-a", "closed", { closed_at: "2026-09-02T00:00:00Z" }),
];
// A long Ready column, so its lowest cards sit at the bottom of the board area.
const longReady = () => [
  ...Array.from({ length: 16 }, (_, i) => bead(`r${String(i).padStart(2, "0")}`, "open")),
  bead("done-a", "closed", { closed_at: "2026-09-02T00:00:00Z" }),
];
// A long Waiting column with Done hidden: the bar offers Done (a close).
const longWaiting = () => [
  ...Array.from({ length: 16 }, (_, i) => bead(`w${String(i).padStart(2, "0")}`, "deferred")),
  bead("ready-a", "open"),
  bead("busy", "in_progress"),
];

let beads = readyAndDone();
let pollIntervalMs = 300000;
const writes = [];

const browser = await chromium.launch();
let page;
try {
  async function openContext(options) {
    const context = await browser.newContext(options);
    const p = await context.newPage();
    p.setDefaultTimeout(9000);
    const errors = [];
    p.on("pageerror", (error) => errors.push(error.message));
    await p.route("**/api/p/demo/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/beads/stream")) return route.abort();
      if (path.endsWith("/order")) {
        if (request.method() !== "GET") writes.push({ id: "order", body: request.postDataJSON() });
        return route.fulfill({ json: { orders: {} } });
      }
      if (path.endsWith("/beads")) return route.fulfill({ json: { beads, meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs } } });
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
    return { context, page: p, errors };
  }

  const card = (p, id) => p.locator(`[data-keyboard-bead-id="${id}"]`);
  const shown = (p) => p.locator("main [data-board-column]").evaluateAll((sections) => sections.map((s) => s.dataset.boardColumn));
  const widths = (p) => p.locator("main [data-board-column]").evaluateAll((sections) => sections.map((s) => s.getBoundingClientRect().width));
  // Position and size of every visible column, to prove a drag moves none of them.
  const boxes = (p) =>
    p.locator("main [data-board-column]").evaluateAll((sections) =>
      sections.map((s) => {
        const r = s.getBoundingClientRect();
        return { id: s.dataset.boardColumn, x: r.x, y: r.y, width: r.width, height: r.height };
      }));
  // Each column's cards, in order: a short press must leave this unchanged.
  const layout = (p) =>
    p.locator("main [data-board-column]").evaluateAll((sections) =>
      sections.map((s) => [s.dataset.boardColumn, [...s.querySelectorAll("article")].map((a) => a.dataset.keyboardBeadId)]));
  const bar = (p) => p.locator("[data-drop-bar]");
  const barTargets = (p) => p.locator("[data-drop-bar-target]").evaluateAll((targets) => targets.map((t) => t.dataset.dropBarTarget));
  const boardArea = (p) => p.locator("main [data-board-column]").first().locator("xpath=../../..");
  const expectShown = async (p, ids, message) => {
    await p.waitForFunction(
      (wanted) => JSON.stringify([...document.querySelectorAll("main [data-board-column]")].map((s) => s.dataset.boardColumn)) === JSON.stringify(wanted),
      ids,
    ).catch(() => undefined);
    assert.deepEqual(await shown(p), ids, message);
  };
  const open = async (p, query = "") => {
    await p.goto(`${base}/p/demo${query}`);
    await p.getByRole("heading", { name: "Board", exact: true }).waitFor();
    await p.locator("main [data-board-column]").first().waitFor();
  };
  const unlock = async (context) => {
    const response = await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
    assert.equal(response.status(), 200, "isolated demo can be unlocked for mutation assertions");
  };
  const pickUp = async (p, id) => {
    const box = await card(p, id).boundingBox();
    assert.ok(box, `${id} must be visible`);
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    const pointer = { x: box.x + box.width / 2 + 8, y: box.y + box.height / 2 + 8 };
    await p.mouse.move(pointer.x, pointer.y, { steps: 2 });
    return pointer;
  };
  // The drag preview (the overlay copy of the card) sits under the pointer.
  const previewUnderPointer = (p, point, id) =>
    p.evaluate(({ x, y, title }) =>
      document.elementsFromPoint(x, y).some((el) => el.closest('article[aria-hidden="true"]')?.textContent?.includes(title)), { ...point, title: `Empty columns ${id}` });

  // The drop bar covers only the header row: it starts at the top of the board area
  // and ends above every column body, so no card and no drop area is under it.
  const assertBarClearOfBodies = async (p) => {
    const area = await boardArea(p).boundingBox();
    const barBox = await bar(p).boundingBox();
    const bodyTop = Math.min(...(await p.locator("main [data-board-column-body]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))));
    assert.ok(Math.abs(barBox.y - area.y) <= 1, "the bar starts at the top edge of the board area");
    assert.ok(barBox.y + barBox.height <= bodyTop, `the bar ends above every column body: ${barBox.y + barBox.height} <= ${bodyTop}`);
    for (const target of await p.locator("[data-drop-bar-target]").all()) {
      const r = await target.boundingBox();
      assert.ok(r.height >= 44 && r.width >= 44, `bar targets are large enough for touch: ${r.width}x${r.height}`);
    }
  };

  // A press that moves a few px (enough to start a drag) and is released at once.
  // `press` returns while the drag runs, so the caller can check the bar is up.
  const pressMouse = (p) => ({
    down: async (point) => { await p.mouse.move(point.x, point.y); await p.mouse.down(); },
    move: async (point) => { await p.mouse.move(point.x, point.y, { steps: 3 }); },
    up: async () => { await p.mouse.up(); },
  });
  const pressTouch = async (context, p) => {
    const cdp = await context.newCDPSession(p);
    const touch = (point) => [{ x: point.x, y: point.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    let last;
    return {
      down: async (point) => { last = point; await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(point) }); },
      move: async (point) => {
        for (let i = 1; i <= 3; i++) {
          const step = { x: last.x + ((point.x - last.x) * i) / 3, y: last.y + ((point.y - last.y) * i) / 3 };
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(step) });
          await p.waitForTimeout(16);
        }
        last = point;
      },
      up: async () => { await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); },
    };
  };
  // Press `from`, move to `to`, check the drag started (the bar is up), release.
  // Nothing may change: no write, the same cards in the same places, no bar.
  const shortPress = async (p, input, from, to, label) => {
    const writesBefore = writes.length;
    const layoutBefore = await layout(p);
    const boxesBefore = await boxes(p);
    await input.down(from);
    await input.move(to);
    await bar(p).waitFor();
    if (label.expectOverBar) {
      // (elementsFromPoint: the drag preview is on top of everything under the pointer.)
      assert.ok(await p.evaluate(({ x, y }) => document.elementsFromPoint(x, y).some((el) => el.closest("[data-drop-bar-target]")), to), `${label.name}: the pointer is over a bar target`);
    }
    if (label.hold) await p.waitForTimeout(label.hold);
    await input.up();
    await bar(p).waitFor({ state: "detached" });
    await p.waitForTimeout(400);
    assert.deepEqual(writes.slice(writesBefore), [], `${label.name}: nothing is written`);
    assert.deepEqual(await layout(p), layoutBefore, `${label.name}: every card stays where it was`);
    assert.deepEqual(await boxes(p), boxesBefore, `${label.name}: the board is as it was`);
  };
  // The lowest card in a column that a finger can press: the card whose visible part
  // ends lowest. Press 12 px above its visible bottom (the band where a bottom bar
  // used to sit), then move 6 px down.
  const lowestCardPress = async (p, columnId) => {
    const body = await p.locator(`[data-board-column="${columnId}"] [data-board-column-body]`).boundingBox();
    const cards = await p.locator(`[data-board-column="${columnId}"] article`).evaluateAll((els) =>
      els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.keyboardBeadId, x: r.x + r.width / 2, top: r.top, bottom: r.bottom }; }));
    const visible = cards
      .map((c) => ({ ...c, visibleBottom: Math.min(c.bottom, body.y + body.height), visibleTop: Math.max(c.top, body.y) }))
      .filter((c) => c.visibleBottom - c.visibleTop >= 24);
    const lowest = visible.reduce((a, b) => (b.visibleBottom > a.visibleBottom ? b : a));
    const from = { x: lowest.x, y: lowest.visibleBottom - 12 };
    return { id: lowest.id, from, to: { x: from.x, y: from.y + 6 } };
  };
  // The top card: press 16 px below its top edge, then move 6 px up. (A press low in
  // a column can scroll it a little, so the column goes back to its top first.)
  const topCardPress = async (p, columnId) => {
    await p.locator(`[data-board-column="${columnId}"] [data-board-column-body]`).evaluate((el) => { el.scrollTop = 0; });
    const r = await p.locator(`[data-board-column="${columnId}"] article`).first().boundingBox();
    const from = { x: r.x + r.width / 2, y: r.y + 16 };
    return { from, to: { x: from.x, y: from.y - 6 } };
  };

  // ---------------- desktop, mouse ----------------
  const desk = await openContext({ viewport: { width: 1700, height: 1000 } });
  page = desk.page;

  await open(page);
  await card(page, "done-a").waitFor();
  await expectShown(page, ["ready", "done"], "only the columns with cards show");
  assert.deepEqual(await widths(page), [296, 296], "visible columns keep their width");
  assert.equal(await bar(page).count(), 0, "no drop bar without a drag");

  // The isolated server starts read-only, where cards do not drag, so no bar appears.
  await pickUp(page, "ready-a");
  await page.waitForTimeout(150);
  assert.equal(await bar(page).count(), 0, "read-only: pressing a card shows no drop bar");
  assert.deepEqual(await shown(page), ["ready", "done"]);
  await page.mouse.up();

  await unlock(desk.context);
  await open(page);
  await card(page, "ready-a").waitFor();

  // While a card is dragged, the hidden columns that would take it are offered in a
  // bar over the header row. Blocked takes no drops and Done is on screen, so the bar
  // holds Waiting and In Progress. Nothing on the board moves or resizes.
  const before = await boxes(page);
  const pointer = await pickUp(page, "ready-a");
  await bar(page).waitFor();
  assert.deepEqual(await boxes(page), before, "the visible columns keep their positions and sizes during a drag");
  assert.deepEqual(await shown(page), ["ready", "done"], "a drag puts no column back into the row");
  assert.deepEqual(await barTargets(page), ["backlog", "in_progress"], "one bar target per hidden column that takes the card, in column order");
  assert.deepEqual(await page.locator("[data-drop-bar-target]").allTextContents(), ["Move to Waiting", "Move to In Progress"]);
  await assertBarClearOfBodies(page);
  assert.ok(await previewUnderPointer(page, pointer, "ready-a"), "the drag preview stays under the pointer");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await bar(page).waitFor({ state: "detached" });
  assert.deepEqual(writes, [], "a cancelled drag writes nothing");
  assert.deepEqual(await boxes(page), before);

  // A drop on a bar target counts as a drop on that column.
  await pickUp(page, "ready-a");
  await bar(page).waitFor();
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
  await expectShown(page, ["ready", "in_progress", "done"], "the card's new column shows; the others stay hidden");
  assert.equal(await bar(page).count(), 0, "the bar goes away after the drop");
  writes.length = 0;

  // Short presses that start a drag and are released at once change nothing.
  beads = longReady();
  await open(page);
  await card(page, "done-a").waitFor();
  const low = await lowestCardPress(page, "ready");
  const area = await boardArea(page).boundingBox();
  assert.ok(low.from.y > area.y + area.height - 81, "the lowest card is pressed in the band a bottom bar used to cover");
  await shortPress(page, pressMouse(page), low.from, low.to, { name: `mouse, lowest Ready card ${low.id}` });
  // A wiggle at the very edge of the lowest card (3 px above its visible bottom,
  // 8 px down, past the edge) is still a press in place: a drag that ends within
  // 12 px of its start changes nothing.
  // (Measured again: the press above can scroll the column a little.)
  const lowAgain = await lowestCardPress(page, "ready");
  const lowEdge = { x: lowAgain.from.x, y: lowAgain.from.y + 9 };
  await shortPress(page, pressMouse(page), lowEdge, { x: lowEdge.x, y: lowEdge.y + 8 }, { name: "mouse, lowest card wiggled past its bottom edge" });
  const top = await topCardPress(page, "ready");
  await shortPress(page, pressMouse(page), top.from, top.to, { name: "mouse, top Ready card" });
  // A 12 px upward wiggle from the top edge of the top card reaches the bar, but a
  // bar target only counts 24 px from where the drag started, so nothing happens.
  const topBox = await page.locator('[data-board-column="ready"] article').first().boundingBox();
  const edge = { x: topBox.x + topBox.width / 2, y: topBox.y + 3 };
  await shortPress(page, pressMouse(page), edge, { x: edge.x, y: edge.y - 13 }, { name: "mouse, top card wiggled up into the bar", expectOverBar: true });
  // The close case: Done is hidden, so the bar offers Done; a low Waiting card stays.
  beads = longWaiting();
  await open(page);
  await card(page, "busy").waitFor();
  const lowWaiting = await lowestCardPress(page, "backlog");
  await shortPress(page, pressMouse(page), lowWaiting.from, lowWaiting.to, { name: `mouse, lowest Waiting card ${lowWaiting.id}` });

  // Empty space low in a visible column still takes that column's drop (no bar there).
  beads = readyAndDone();
  beads.push(bead("busy", "in_progress"));
  await open(page);
  await card(page, "busy").waitFor();
  await pickUp(page, "ready-a");
  await bar(page).waitFor();
  const progressBody = await page.locator('[data-board-column="in_progress"] [data-board-column-body]').boundingBox();
  await page.mouse.move(progressBody.x + progressBody.width / 2, progressBody.y + progressBody.height - 30, { steps: 12 });
  await page.waitForTimeout(150);
  const lowWrite = page.waitForResponse((response) => response.url().endsWith("/beads/ready-a/status") && response.request().method() === "POST");
  await page.mouse.up();
  await lowWrite;
  assert.deepEqual(writes, [{ id: "ready-a", body: { status: "in_progress" } }], "empty space low in In Progress takes the drop");
  writes.length = 0;

  // A bar target whose drop would change nothing is not offered: an open card that
  // waits on work (in Waiting) gets no Ready target, so here the bar does not show.
  beads = [bead("busy", "in_progress"), bead("later", "open", blocks("busy")), bead("done-a", "closed")];
  await open(page);
  await card(page, "later").waitFor();
  await expectShown(page, ["backlog", "in_progress", "done"]);
  await pickUp(page, "later");
  await page.waitForTimeout(150);
  assert.equal(await bar(page).count(), 0, "no bar when no hidden column would take the card");
  await page.keyboard.press("Escape");
  await page.mouse.up();

  // A drop whose card lands in another column than the one it was dropped on says so.
  beads = [bead("busy", "in_progress"), bead("parked", "deferred", blocks("busy")), bead("free", "open"), bead("done-a", "closed")];
  await open(page);
  await card(page, "parked").waitFor();
  await pickUp(page, "parked");
  const free = await card(page, "free").boundingBox();
  await page.mouse.move(free.x + free.width / 2, free.y + free.height / 2, { steps: 12 });
  await page.waitForTimeout(150);
  const parkedWrite = page.waitForResponse((response) => response.url().endsWith("/beads/parked/status") && response.request().method() === "POST");
  await page.mouse.up();
  await parkedWrite;
  assert.deepEqual(writes, [{ id: "parked", body: { status: "open" } }]);
  await page.getByText("It waits on other work, so it stays in Waiting.", { exact: true }).waitFor();
  await page.locator('[data-board-column="backlog"] [data-keyboard-bead-id="parked"]').waitFor();
  writes.length = 0;

  // A live update during a drag shows or hides no column: the row keeps the set it
  // had when the drag started, and takes the new set when the drag ends.
  beads = readyAndDone();
  pollIntervalMs = 400;
  await open(page);
  await card(page, "ready-a").waitFor();
  const frozenBoxes = await boxes(page);
  await pickUp(page, "ready-a");
  await bar(page).waitFor();
  beads.push(bead("agent-started", "in_progress"));
  await page.waitForResponse((response) => response.url().endsWith("/api/p/demo/beads") && response.request().method() === "GET");
  await page.waitForTimeout(300);
  assert.deepEqual(await shown(page), ["ready", "done"], "a live update during a drag adds no column to the row");
  assert.deepEqual(await boxes(page), frozenBoxes, "and moves none");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expectShown(page, ["ready", "in_progress", "done"], "after the drag the new column shows");
  pollIntervalMs = 300000;
  assert.deepEqual(writes, []);

  // Counts follow the filters: a type filter can hide some columns and keep others.
  beads = [...readyAndDone(), bead("bug-busy", "in_progress", { issue_type: "bug" })];
  await open(page, "?type=bug");
  await expectShown(page, ["in_progress"], "a type filter hides the columns it empties");
  await open(page, "?type=task");
  await expectShown(page, ["ready", "done"]);
  // A search that matches nothing leaves every column empty, so all show.
  await open(page, "?q=nothing-matches-this");
  await expectShown(page, ["backlog", "ready", "blocked", "in_progress", "done"], "a board with no visible cards shows all five columns");

  // A board with no beads at all shows all five columns too.
  beads = [];
  await open(page);
  await expectShown(page, ["backlog", "ready", "blocked", "in_progress", "done"], "an empty board shows all five columns");

  // A chosen Done window that empties Done keeps Done (and its window control) on
  // screen, so Done is not hidden and gets no bar target.
  beads = readyAndDone();
  await open(page, "?done=7");
  await card(page, "ready-b").waitFor();
  await expectShown(page, ["ready", "done"], "Done stays while a window is chosen, so the window can be changed back");
  assert.equal(await page.locator('[data-board-column="done"] article').count(), 0);
  assert.equal(await page.locator('[data-board-column="done"] select').inputValue(), "7");
  await pickUp(page, "ready-b");
  await bar(page).waitFor();
  assert.deepEqual(await barTargets(page), ["backlog", "in_progress"]);
  await page.keyboard.press("Escape");
  await page.mouse.up();

  // A Blocked column pinned in Settings still shows when empty.
  await page.evaluate(() => localStorage.setItem("bmus.board", JSON.stringify({ blockedColumn: "always" })));
  await open(page);
  await card(page, "ready-b").waitFor();
  await expectShown(page, ["ready", "blocked", "done"], "a pinned Blocked column shows when empty");
  assert.deepEqual(desk.errors, []);
  await desk.context.close();

  // ---------------- iPad size, touch ----------------
  const pad = await openContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, deviceScaleFactor: 2 });
  page = pad.page;
  await unlock(pad.context);
  beads = longReady();
  await open(page);
  await card(page, "done-a").waitFor();
  const touch = await pressTouch(pad.context, page);
  const padLow = await lowestCardPress(page, "ready");
  await shortPress(page, touch, padLow.from, padLow.to, { name: `touch, lowest Ready card ${padLow.id}` });
  const padTop = await topCardPress(page, "ready");
  await shortPress(page, touch, padTop.from, padTop.to, { name: "touch, top Ready card" });
  // The review's repro spot: 40 px above the bottom of the board area, an 8 px
  // diagonal finger move. It used to drop the card on the bar.
  const padArea = await boardArea(page).boundingBox();
  const padReady = await page.locator('[data-board-column="ready"] [data-board-column-body]').boundingBox();
  const spot = { x: padReady.x + padReady.width / 2, y: padArea.y + padArea.height - 40 };
  for (let i = 0; i < 3 && !(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest("article"), spot)); i++) spot.y -= 12;
  await shortPress(page, touch, spot, { x: spot.x + 8, y: spot.y + 8 }, { name: "touch, the review's spot near the bottom" });
  // During a touch drag the bar is clear of the column bodies and touch-sized.
  await page.locator('[data-board-column="ready"] [data-board-column-body]').evaluate((el) => { el.scrollTop = 0; });
  const padFirst = await page.locator('[data-board-column="ready"] article').first().boundingBox();
  await touch.down({ x: padFirst.x + padFirst.width / 2, y: padFirst.y + padFirst.height / 2 });
  await touch.move({ x: padFirst.x + padFirst.width / 2 + 8, y: padFirst.y + padFirst.height / 2 + 8 });
  await bar(page).waitFor();
  await assertBarClearOfBodies(page);
  // A touch drop on a bar target works too.
  const padTarget = await page.locator('[data-drop-bar-target="backlog"]').boundingBox();
  await touch.move({ x: padTarget.x + padTarget.width / 2, y: padTarget.y + padTarget.height / 2 });
  await page.waitForTimeout(150);
  const padWrite = page.waitForResponse((response) => response.url().endsWith("/status") && response.request().method() === "POST");
  await touch.up();
  await padWrite;
  assert.deepEqual(writes, [{ id: "r00", body: { status: "deferred" } }], "a touch drop on the Waiting bar target writes deferred");
  await page.locator('[data-board-column="backlog"] [data-keyboard-bead-id="r00"]').waitFor();
  // Let the drop's refetch settle before the next touch, as a person would.
  await page.waitForTimeout(600);
  // The same spot, held for 300 ms: the column also scrolls under the finger
  // (dnd-kit's autoscroll near an edge). The release still changes nothing,
  // because the finger itself moved under 12 px.
  // (Waiting now shows, so Ready has moved: measure the spot again.)
  // An earlier press may have scrolled the column a little, so step up out of a gap
  // between two cards if the spot lands in one.
  const heldReady = await page.locator('[data-board-column="ready"] [data-board-column-body]').boundingBox();
  const held = { x: heldReady.x + heldReady.width / 2, y: padArea.y + padArea.height - 40 };
  for (let i = 0; i < 3 && !(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest("article"), held)); i++) held.y -= 12;
  await shortPress(page, touch, held, { x: held.x + 8, y: held.y + 8 }, { name: "touch, the review's spot, held while the column scrolls", hold: 300 });
  assert.deepEqual(pad.errors, []);

  console.log("PASS: empty columns hide; during a drag a drop bar over the header row offers the hidden columns that would take the card, never covers a column body and moves nothing; short presses on the lowest and top cards change nothing (mouse, and touch at iPad size); bar drops work; live updates during a drag change no column; filters, an empty board, the Done window and a pinned Blocked column behave");
} catch (error) {
  console.error({ writes, url: page?.url() });
  throw error;
} finally {
  await browser.close();
}
