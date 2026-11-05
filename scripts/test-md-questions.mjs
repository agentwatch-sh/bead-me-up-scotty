// Browser regression fixture: Markdown (with GitHub tables) in a version-2
// question's text, option labels and option descriptions. Every project request
// is intercepted; this never reaches a Beads database. Run against a dev or
// production server, with a phone-sized screen:
//   SCOTTY_TEST_URL=http://localhost:3000 [SCOTTY_TEST_SHOT=path.png] node scripts/test-md-questions.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to the running demo server");

const table = [
  "| Plan | Package | Migration time | Risk | Pick |",
  "| --- | --- | --- | --- | --- |",
  "| Keep | `queue-service-1.8.2` | `2026-11-20` | `low-risk` | No |",
  "| Move | `queue-service-2.0.1` | `2027-01-15` | `medium-risk` | Yes |",
].join("\n");
const options = [
  { id: "new", label: "**Move** to the `new` queue [docs](https://example.com/q)", description: "Pays more. See [the notes](https://example.com/n).\n\n| Cost | Time | Risk | Gain | Pick |\n| --- | --- | --- | --- | --- |\n| 300 dollars | 5 weeks | Medium | High | Yes |", recommended: true },
  // Block and raw-HTML input in a label must not break the one-line label.
  { id: "old", label: "# Keep <img src=x onerror=\"window.__pwned=1\"> the old one\n\n- item", description: "Pays less. <script>window.__pwned=2</script>", recommended: false },
];
const question = { id: "q1", header: "Queue", multiSelect: false, question: `Which **queue** do we use?\n\n${table}\n\nSee <b>raw</b> [the plan](https://example.com/p).`, options };
const bead = {
  id: "ask", title: "Pick a queue", status: "open", issue_type: "task", priority: 2, labels: ["human", "question"], dependencies: [],
  metadata: { "scotty.choices": { version: 2, questions: [question] } },
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

const browser = await chromium.launch({ executablePath: process.env.SCOTTY_BROWSER_EXECUTABLE || undefined });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/viewer-mode", (route) => route.fulfill({ json: { readOnly: false } }));
  await page.route("**/api/p/demo/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (path.endsWith("/beads")) return route.fulfill({ json: { beads: [bead], meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 250 } } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/p/demo?bead=ask`);
  const panel = page.locator('[data-human-answer="ask"]');
  const fieldset = panel.locator('[data-question-id="q1"]');
  await fieldset.getByRole("button", { name: /Move to the new queue/ }).waitFor();

  // Question text: Markdown, a five-column table that scrolls inside its box.
  assert.equal(await fieldset.locator("strong", { hasText: "queue" }).count(), 1, "bold renders in the question text");
  const scroller = fieldset.locator(".bd-md-table-scroll").first();
  assert.equal(await scroller.locator("thead th").count(), 5, "the question table has five columns");
  const m = await scroller.evaluate((el) => ({ overflowX: getComputedStyle(el).overflowX, client: el.clientWidth, scroll: el.scrollWidth }));
  assert.equal(m.overflowX, "auto");
  assert.ok(m.scroll > m.client, `the question table is wider than its box (${m.scroll} > ${m.client})`);
  assert.equal(await fieldset.getByRole("link", { name: "the plan" }).count(), 1, "a link in the question text is a link");
  assert.equal(await fieldset.locator("b").count(), 0, "raw HTML in the question text does not render");

  // Labels stay inline; links inside a button are plain text.
  const first = fieldset.getByRole("button", { name: /Move to the new queue/ });
  assert.equal(await first.locator("strong").count(), 1);
  assert.equal(await first.locator("code", { hasText: "new" }).count(), 1);
  assert.equal(await first.locator("a").count(), 0, "no link nests in an option button");
  // An option description is inline only: a table in it shows as text, never as a table.
  assert.equal(await first.locator("table, .bd-md-table-scroll").count(), 0, "no table inside an option button");
  assert.ok((await first.innerText()).includes("300 dollars"), "the table's cells show as text in the option description");
  const second = fieldset.getByRole("button", { name: /Keep the old one/ });
  assert.equal(await second.locator("h1, ul, li, table, img, script").count(), 0, "no block or raw-HTML element in a label or description");
  assert.equal(await page.evaluate(() => window.__pwned), undefined, "raw HTML never runs");
  // The label holds no paragraph: it is a span inside the label row.
  assert.equal(await first.locator("span.flex").first().locator("p, div").count(), 0, "a label holds no block element");

  // Choosing an option still works, and the answer keeps the source Markdown text.
  await first.click();
  assert.equal(await first.getAttribute("aria-pressed"), "true");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "the page does not scroll sideways");
  if (process.env.SCOTTY_TEST_SHOT) await page.screenshot({ path: process.env.SCOTTY_TEST_SHOT });
  assert.deepEqual(errors, []);
  console.log("PASS: Markdown in question text, labels and descriptions; five-column tables scroll at 390x844");
} finally {
  await browser.close();
}
