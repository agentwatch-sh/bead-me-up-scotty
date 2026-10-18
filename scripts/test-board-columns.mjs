// Board column mapping. The first part loads the real lib modules without a
// server; the second uses only intercepted demo fixtures, so no project data is
// read or written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { chromium } from "playwright";

const nodeRequire = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const code = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // ("server-only" refuses to load outside Next; it has no exports to stand in for.)
  vm.runInNewContext(code, { exports, require: (id) => (id === "server-only" ? {} : id.startsWith("./") ? load(id.slice(2)) : nodeRequire(id)) });
  return exports;
}
const { blockKind, isBlocked, isItem, makeIndex, needsHuman, readyHumanGate, waitsOnPerson } = load("beads-view");
const { colOf, COLUMN_ORDER, BOARD_COLUMNS } = load("board-columns");
const { computeInsights } = load("insights");

const bead = (id, extra = {}) => ({
  id,
  title: `Column ${id}`,
  status: "open",
  issue_type: "task",
  priority: 2,
  labels: [],
  dependencies: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...extra,
});
const dep = (type, depends_on_id) => ({ type, depends_on_id });
const on = (...targets) => ({ dependencies: targets.map((t) => dep("blocks", t)) });

// ---- the mapping, on the real modules ----

// The first column keeps the id "backlog", so saved orders and scotty.rank need no migration.
// (Copied into this realm's arrays: the modules run in their own vm context.)
assert.deepEqual([...COLUMN_ORDER], ["backlog", "ready", "blocked", "in_progress", "done"], "column order, left to right");
assert.deepEqual(Array.from(BOARD_COLUMNS, (c) => c.name), ["Waiting", "Ready", "Blocked", "In Progress", "Done"]);
assert.equal(BOARD_COLUMNS[0].status, "deferred", "a drop into Waiting still sets deferred");

// "Waits on a person" matches the Needs You list: a dependency counts only when it is
// an item that Needs You shows (a `human` item or a human gate) and that the person
// can act on now (not deferred, not itself blocked). Anything else is other work.
const items = [
  bead("task-open"),
  bead("task-deferred", { status: "deferred" }),
  bead("epic-open", { issue_type: "epic" }),
  bead("question", { labels: ["human", "question"] }),
  bead("human", { labels: ["human"] }),
  bead("human-in-progress", { status: "in_progress", labels: ["human", "blocker"] }),
  bead("question-only", { labels: ["question"] }),
  bead("assumption-only", { labels: ["assumption"] }),
  bead("blocker-only", { labels: ["blocker"] }),
  bead("question-deferred", { status: "deferred", labels: ["human", "question"] }),
  bead("question-status-blocked", { status: "blocked", labels: ["human", "question"] }),
  bead("question-waits-work", { labels: ["human", "question"], ...on("task-open") }),
  bead("gate", { issue_type: "gate", await_type: "human" }),
  bead("gate-waits-work", { issue_type: "gate", await_type: "human", ...on("task-open") }),
  bead("gate-deferred", { issue_type: "gate", await_type: "human", status: "deferred" }),
  bead("question-closed", { status: "closed", labels: ["human", "question"] }),
  bead("epic-human", { issue_type: "epic", labels: ["human"] }),
];
const cases = [
  // [bead, kind, column]
  [bead("waits-work", on("task-open")), "work", "backlog"],
  [bead("waits-missing", on("not-in-index")), "work", "backlog"],
  [bead("waits-for-work", { dependencies: [dep("waits-for", "task-open")] }), "work", "backlog"],
  [bead("waits-deferred-task", on("task-deferred")), "work", "backlog"],
  [bead("waits-epic", on("epic-open")), "work", "backlog"],
  [bead("waits-question", on("question")), "gate", "blocked"],
  [bead("waits-human", { dependencies: [dep("conditional-blocks", "human")] }), "gate", "blocked"],
  [bead("waits-human-started", { dependencies: [dep("waits-for", "human-in-progress")] }), "gate", "blocked"],
  [bead("waits-gate", on("gate")), "gate", "blocked"],
  [bead("waits-both", on("task-open", "question")), "gate", "blocked"],
  // Not in Needs You, or not actionable yet: other work.
  [bead("waits-question-only", on("question-only")), "work", "backlog"],
  [bead("waits-assumption-only", on("assumption-only")), "work", "backlog"],
  [bead("waits-blocker-only", on("blocker-only")), "work", "backlog"],
  [bead("waits-deferred-question", on("question-deferred")), "work", "backlog"],
  [bead("waits-blocked-question", on("question-status-blocked")), "work", "backlog"],
  [bead("waits-question-on-work", on("question-waits-work")), "work", "backlog"],
  [bead("waits-gate-on-work", on("gate-waits-work")), "work", "backlog"],
  [bead("waits-deferred-gate", on("gate-deferred")), "work", "backlog"],
  [bead("free"), "none", "ready"],
  [bead("answered", on("question-closed")), "none", "ready"],
  [bead("child-of-human", { dependencies: [dep("parent-child", "epic-human")] }), "none", "ready"],
  [bead("related-question", { dependencies: [dep("related", "question")] }), "none", "ready"],
  [bead("deferred", { status: "deferred" }), "none", "backlog"],
  [bead("deferred-gated", { status: "deferred", ...on("question") }), "gate", "backlog"],
  [bead("status-blocked", { status: "blocked" }), "none", "blocked"],
  [bead("busy-gated", { status: "in_progress", ...on("question") }), "gate", "in_progress"],
  [bead("hooked-work", { status: "hooked", ...on("task-open") }), "work", "in_progress"],
  [bead("closed", { status: "closed", ...on("question") }), "gate", "done"],
];
const index = makeIndex([...items, ...cases.map(([b]) => b)]);
for (const [b, kind, column] of cases) {
  assert.equal(blockKind(b, index), kind, `${b.id}: kind`);
  assert.equal(colOf(b, index), column, `${b.id}: column`);
}
// Every item that makes a task "wait on a person" is one that Needs You shows and
// that is not blocked: Blocked always means "you can unblock this now".
for (const item of index.values()) {
  if (waitsOnPerson(item, index)) {
    assert.ok(needsHuman(item) || readyHumanGate(item, index), `${item.id} is in Needs You`);
    assert.equal(isBlocked(item, index), false, `${item.id} is not itself blocked`);
  }
}
// A bead labelled question, assumption or blocker is an item for a person, not work:
// it sits in no column, open, started or closed. `human` alone does not make an item.
for (const id of ["question", "question-only", "assumption-only", "blocker-only", "human-in-progress", "question-closed", "question-deferred"]) {
  assert.equal(isItem(index.get(id)), true, `${id} is an item`);
  assert.equal(colOf(index.get(id), index), null, `${id} sits in no column`);
}
assert.equal(isItem(index.get("human")), false, "a bead with only `human` is work");
assert.equal(colOf(index.get("human"), index), "ready", "and it sits in a column");
// A gate (no item label) is not an item; one that waits on work sits in Waiting.
assert.equal(isItem(index.get("gate-waits-work")), false);
assert.equal(colOf(index.get("gate-waits-work"), index), "backlog");
// Insights count work only: the column counts and the created counts leave items out.
const all = [...index.values()];
const work = all.filter((b) => !isItem(b));
const insights = computeInsights(all, [], [], 30, Date.parse("2026-09-15T00:00:00Z"));
const counted = Object.fromEntries(Array.from(insights.columns, (c) => [c.id, c.count]));
const expectedCounts = Object.fromEntries(COLUMN_ORDER.map((id) => [id, work.filter((b) => colOf(b, index) === id).length]));
assert.deepEqual({ ...counted }, expectedCounts, "Insights column counts cover work only");
assert.equal(Array.from(insights.columns).reduce((n, c) => n + c.count, 0), work.length, "every work bead is counted once, no item is");
assert.equal(Array.from(insights.createdClosed).reduce((n, d) => n + d.created, 0), work.length, "created counts leave items out");
// Only the column changed: an open bead waiting on other work still counts as blocked.
assert.equal(isBlocked(index.get("waits-work"), index), true, "isBlocked() is unchanged for work-waiting beads");
assert.equal(isBlocked(index.get("waits-question"), index), true);
assert.equal(isBlocked(index.get("waits-deferred-question"), index), true);
assert.equal(isBlocked(index.get("free"), index), false);

// ---- the board in a browser ----

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");

const beads = [
  bead("upstream", { title: "Earlier plan step" }),
  bead("question", { title: "Which region?", priority: 1, labels: ["human", "question"] }),
  bead("old-question", { title: "Which colour?", status: "closed", closed_at: "2026-09-02T00:00:00Z", labels: ["human", "question"] }),
  bead("ask-human", { title: "Work that a person does", labels: ["human"] }),
  bead("later-step", { title: "Later plan step", ...on("upstream") }),
  bead("needs-answer", { title: "Needs an answer", ...on("question") }),
  bead("free", { title: "Nothing in the way" }),
  bead("parked", { title: "Parked", status: "deferred" }),
  bead("busy", { title: "Started, then blocked", status: "in_progress", ...on("question") }),
  bead("shipped", { title: "Shipped", status: "closed", closed_at: "2026-09-02T00:00:00Z" }),
];
const expected = {
  "later-step": "backlog",
  parked: "backlog",
  free: "ready",
  upstream: "ready",
  "ask-human": "ready",
  "needs-answer": "blocked",
  busy: "in_progress",
  shipped: "done",
};
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
  const columnIds = () => page.locator("main [data-board-column]").evaluateAll((sections) => sections.map((s) => s.dataset.boardColumn));
  const placement = () =>
    page.locator("main [data-board-column] article").evaluateAll((cards) =>
      Object.fromEntries(cards.map((c) => [c.dataset.keyboardBeadId, c.closest("[data-board-column]").dataset.boardColumn])));

  await page.goto(`${base}/p/demo`);
  await page.getByRole("heading", { name: "Board", exact: true }).waitFor();
  await card("shipped").waitFor();
  assert.deepEqual(await columnIds(), ["backlog", "ready", "blocked", "in_progress", "done"], "the board shows the columns in the new order");
  const titles = await page.locator("main [data-board-column] > div:first-child > span:nth-child(2)").allTextContents();
  assert.deepEqual(titles, ["Waiting", "Ready", "Blocked", "In Progress", "Done"], "the first column reads Waiting");
  assert.deepEqual(await placement(), expected, "each card sits in the column its status and blockers choose; items sit in none");
  assert.equal(await card("question").count(), 0, "an open question with no blockers is in no column");
  assert.equal(await card("old-question").count(), 0, "a closed question is not in Done");
  // The counts cover work only.
  await page.getByText("8 beads", { exact: false }).first().waitFor();
  const counts = await page.locator("main [data-board-column] > div:first-child > span:nth-child(3)").allTextContents();
  assert.deepEqual(counts, ["2", "3", "1", "1", "1"], "column counts leave items out");

  // The task that waits on the question opens it from its "blocked by" row.
  await card("needs-answer").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTitle("Open question", { exact: true }).click();
  await dialog.getByText("Which region?", { exact: true }).first().waitFor();
  await dialog.getByTitle("Close", { exact: true }).click();
  await dialog.waitFor({ state: "detached" });

  // The header hints describe the new rules and stay on one line, like the other headers.
  const waitingHint = page.locator('[data-board-column="backlog"]').getByText("waits on work, or parked", { exact: true });
  const blockedHint = page.locator('[data-board-column="blocked"]').getByText("waits on a person", { exact: true });
  assert.match(await waitingHint.getAttribute("title"), /^Not started: waits on other work, or parked/, "the Waiting hint explains itself on hover");
  assert.match(await blockedHint.getAttribute("title"), /item in Needs You that you can act on now/, "the Blocked hint names the Needs You rule on hover");
  // (Done is left out: its window control makes that header taller on its own.)
  const headerHeights = await page.locator("main [data-board-column]:not([data-board-column=done]) > div:first-child").evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
  assert.equal(headerHeights.length, 4);
  assert.equal(new Set(headerHeights).size, 1, `column headers keep one height: ${headerHeights}`);

  // The list view groups rows in the same order, under the same names.
  await page.goto(`${base}/p/demo?view=list`);
  await page.getByRole("heading", { name: "List", exact: true }).waitFor();
  await card("shipped").waitFor();
  const groups = await page.locator("main span.uppercase").allTextContents();
  assert.deepEqual(groups, ["Waiting", "Ready", "Blocked", "In Progress", "Done", "Items for you"], "list groups follow the column order; items come last, in their own group");
  // The List still lists the questions, marked as items.
  const itemRows = await page.locator("main [data-keyboard-bead-id]").evaluateAll((rows) =>
    rows.filter((r) => r.querySelector("[data-item-chip]")).map((r) => [r.dataset.keyboardBeadId, r.querySelector("[data-item-chip]").textContent]));
  assert.deepEqual(itemRows, [["question", "question"], ["old-question", "question"]], "the List lists the questions with an item chip");

  // Focus shows no item as work: the open P1 question is not in Next up.
  await page.goto(`${base}/p/demo?view=focus`);
  await page.getByRole("heading", { name: "Focus", exact: true }).waitFor();
  await card("needs-answer").waitFor();
  assert.equal(await card("question").count(), 0, "Focus shows no item");

  // A drop keeps its meaning: into Waiting sets deferred, and the card then sits in Waiting.
  const unlock = await context.request.put(`${base}/api/viewer-mode`, { data: { readOnly: false } });
  assert.equal(unlock.status(), 200, "isolated demo can be unlocked for mutation assertions");
  await page.goto(`${base}/p/demo`);
  await card("free").waitFor();
  const from = await card("free").boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 2 });
  const to = await card("parked").boundingBox();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  const statusWrite = page.waitForResponse((response) => response.url().endsWith("/beads/free/status") && response.request().method() === "POST");
  await page.mouse.up();
  await statusWrite;
  assert.deepEqual(writes, [{ id: "free", body: { status: "deferred" } }], "dropping into Waiting writes deferred");
  await page.locator('[data-board-column="backlog"] [data-keyboard-bead-id="free"]').waitFor();

  // An item cannot be dragged anywhere, not even in the List: a drag of the
  // question onto a work row writes nothing.
  await page.goto(`${base}/p/demo?view=list`);
  await card("question").waitFor();
  const itemBox = await card("question").boundingBox();
  const workBox = await card("upstream").boundingBox();
  await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2 - 10, { steps: 2 });
  await page.mouse.move(workBox.x + workBox.width / 2, workBox.y + workBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  assert.deepEqual(writes, [{ id: "free", body: { status: "deferred" } }], "dragging an item in the List writes nothing");

  assert.deepEqual(errors, []);
  console.log("PASS: column order (Waiting, Ready, Blocked, In Progress, Done), work-waiting beads in Waiting, person-waiting beads in Blocked, started work stays In Progress, list order, header hints, and Waiting drops; items (question, assumption, blocker) sit in no column, Focus or count, and stay in the List and the drawer");
} catch (error) {
  console.error({ writes, url: page?.url() });
  throw error;
} finally {
  await browser.close();
}
