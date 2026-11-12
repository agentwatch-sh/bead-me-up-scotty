// Browser regression fixture: references to repo items in board text render as
// links (agentwatch board age-62v) on a phone-sized screen. Every project request
// and the provider (meta.repoRefsUrl) are intercepted; this never reaches a Beads
// database. Run against a dev or production server:
//   SCOTTY_TEST_URL=http://localhost:3000[/board] [SCOTTY_TEST_SHOT=path.png] node scripts/test-repo-refs-ui.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to the running demo server");
const basePath = new URL(base).pathname.replace(/\/+$/, "");

const FILES = new Set(["agentwatch/daemon/no_dump.py", "README.md"]);
const PROVIDER = "/api/board/refs/selden/demo";
// Two providers that do not answer the path checks (review of age-62v): one
// answers its context and fails every path check with a 502, one never answers.
const FAILING = "/api/board/refs/selden/failing";
const SILENT = "/api/board/refs/selden/silent";
let provider = PROVIDER;
const FILE_LINK = "/board-file/selden/demo?path={path}&line={line}&col={column}";
const description = [
  "The fix is in agentwatch/daemon/no_dump.py:68 and `README.md`, commit 55e6b91, issue #654,",
  "upstream brendan-appstart/bead-me-up-scotty#95, blocked by other-1x2.",
  "Not links: agentwatch/daemon/gone.py:3, the decade began, and deadbeef inside x55e6b91.",
  "",
  "```",
  "agentwatch/daemon/no_dump.py:68 55e6b91 #654 other-1x2",
  "```",
].join("\n");
const question = {
  id: "q1", header: "File", multiSelect: false, question: "Keep README.md:3 as in 55e6b91?",
  options: [
    { id: "yes", label: "Keep README.md", description: "As in 55e6b91.", recommended: true },
    { id: "no", label: "Drop it", description: "See #654.", recommended: false },
  ],
};
const bead = (id, title, extra = {}) => ({
  id, title, status: "open", issue_type: "task", priority: 2, labels: [], dependencies: [],
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...extra,
});
const beads = [
  bead("refs-1", "Refs item", {
    description,
    notes: "Notes name README.md~2.",
    comments: [{ id: "c1", author: "agent:aw-lead", text: "Done in `55e6b91`; see other-1x2.", created_at: "2026-09-01T00:00:00Z" }],
  }),
  bead("other-1x2", "The other item"),
  bead("ask-1", "A question", { labels: ["human", "question"], metadata: { "scotty.choices": { version: 2, questions: [question] } } }),
];

const browser = await chromium.launch({ executablePath: process.env.SCOTTY_BROWSER_EXECUTABLE || undefined });
const errors = [];
const asked = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/viewer-mode", (route) => route.fulfill({ json: { readOnly: true } }));
  await page.route("**/api/p/demo/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (path.endsWith("/beads")) {
      return route.fulfill({ json: { beads, meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"],
        pollIntervalMs: 300000, repoRefsUrl: provider } } });
    }
    return route.fulfill({ json: {} });
  });
  await page.route(`**${PROVIDER}**`, (route) => {
    const url = new URL(route.request().url());
    assert.equal(route.request().method(), "GET", "the provider is only read");
    const paths = url.searchParams.getAll("path");
    asked.push(...paths);
    return route.fulfill({ json: { s: "ok", data: { github: "agentwatch-sh/agentwatch", file_link: FILE_LINK,
      files: paths.filter((p) => FILES.has(p)) } } });
  });

  await page.goto(`${base}/p/demo?bead=refs-1`);
  const dialog = page.getByRole("dialog");
  await dialog.locator('a[data-repo-ref="path"]', { hasText: "agentwatch/daemon/no_dump.py:68" }).waitFor();

  const links = await dialog.locator("a[data-repo-ref]").evaluateAll((as) => as.map((a) => ({
    kind: a.getAttribute("data-repo-ref"), text: a.textContent, href: a.getAttribute("href"), target: a.getAttribute("target"),
    code: !!a.querySelector("code"), inPre: !!a.closest("pre"),
  })));
  const want = [
    { kind: "path", text: "agentwatch/daemon/no_dump.py:68", href: "/board-file/selden/demo?path=agentwatch%2Fdaemon%2Fno_dump.py&line=68&col=", target: "_blank", code: false },
    { kind: "path", text: "README.md", href: "/board-file/selden/demo?path=README.md&line=&col=", target: "_blank", code: true },
    { kind: "commit", text: "55e6b91", href: "https://github.com/agentwatch-sh/agentwatch/commit/55e6b91", target: "_blank", code: false },
    { kind: "issue", text: "#654", href: "https://github.com/agentwatch-sh/agentwatch/issues/654", target: "_blank", code: false },
    { kind: "issue", text: "brendan-appstart/bead-me-up-scotty#95", href: "https://github.com/brendan-appstart/bead-me-up-scotty/issues/95", target: "_blank", code: false },
    { kind: "bead", text: "other-1x2", href: `${basePath}/p/demo?bead=other-1x2`, target: null, code: false },
    { kind: "path", text: "README.md~2", href: "/board-file/selden/demo?path=README.md&line=2&col=", target: "_blank", code: false },
    { kind: "commit", text: "55e6b91", href: "https://github.com/agentwatch-sh/agentwatch/commit/55e6b91", target: "_blank", code: true },
    { kind: "bead", text: "other-1x2", href: `${basePath}/p/demo?bead=other-1x2`, target: null, code: false },
  ];
  assert.deepEqual(links.map((l) => ({ kind: l.kind, text: l.text, href: l.href, target: l.target, code: l.code })), want,
    "description, notes and comment links");
  assert.ok(links.every((l) => !l.inPre), "nothing in a fenced code block is a link");
  assert.equal(await dialog.locator("pre a").count(), 0, "the fenced block stays plain");
  assert.ok(await dialog.locator("pre", { hasText: "agentwatch/daemon/no_dump.py:68 55e6b91 #654 other-1x2" }).isVisible());
  for (const text of ["agentwatch/daemon/gone.py:3", "decade", "deadbeef", "x55e6b91"]) {
    assert.equal(await dialog.locator("a", { hasText: text }).count(), 0, `${text} is not a link`);
  }
  assert.ok(asked.includes("agentwatch/daemon/gone.py"), "a missing path was asked about");
  const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.equal(width.scroll, width.client, "the page does not scroll sideways at 390 px");
  if (process.env.SCOTTY_TEST_SHOT) await page.screenshot({ path: process.env.SCOTTY_TEST_SHOT });

  // A board item link opens that item here, with no page load.
  const loads = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) loads.push(frame.url()); });
  await dialog.locator('a[data-repo-ref="bead"]').first().click();
  await dialog.getByText("The other item", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("bead"), "other-1x2");
  assert.deepEqual(loads.filter((u) => !u.includes("bead=")), [], "no full page load");

  // A version-2 question: its text links; its option buttons keep references as text.
  await page.goto(`${base}/p/demo?bead=ask-1`);
  const fieldset = page.locator('[data-human-answer="ask-1"] [data-question-id="q1"]');
  await fieldset.locator('a[data-repo-ref="commit"]').waitFor();
  assert.deepEqual(await fieldset.locator("a[data-repo-ref]").evaluateAll((as) => as.map((a) => [a.getAttribute("data-repo-ref"), a.textContent])),
    [["path", "README.md:3"], ["commit", "55e6b91"]], "the question text links");
  assert.equal(await fieldset.locator("button a").count(), 0, "no link inside an option button");
  assert.ok(await fieldset.getByRole("button", { name: /Keep README\.md/ }).isVisible());

  // A failed path check is not asked again in a loop: the board waits a backoff.
  const failing = { context: 0, paths: 0 };
  await page.route(`**${FAILING}**`, (route) => {
    const paths = new URL(route.request().url()).searchParams.getAll("path");
    if (!paths.length) {
      failing.context += 1;
      return route.fulfill({ json: { s: "ok", data: { github: "agentwatch-sh/agentwatch", file_link: FILE_LINK, files: [] } } });
    }
    failing.paths += 1;
    return route.fulfill({ status: 502, json: { s: "error", errmsg: "Bad gateway" } });
  });
  provider = FAILING;
  await page.goto(`${base}/p/demo?bead=refs-1`);
  await dialog.locator('a[data-repo-ref="commit"]').first().waitFor();
  await page.waitForTimeout(2500);
  assert.equal(failing.context, 1, "one context request");
  assert.ok(failing.paths >= 1 && failing.paths <= 2, `the failed paths were asked ${failing.paths} times in 2.5 s`);
  assert.equal(await dialog.locator('a[data-repo-ref="path"]').count(), 0, "no path links without an answer");

  // A provider that never answers its context is asked about no path.
  const silent = [];
  await page.route(`**${SILENT}**`, (route) => { silent.push(route.request().url()); });
  provider = SILENT;
  await page.goto(`${base}/p/demo?bead=refs-1`);
  await dialog.locator('a[data-repo-ref="bead"]').first().waitFor();
  await page.waitForTimeout(1500);
  assert.equal(silent.length, 1, "only the context request");
  assert.deepEqual(new URL(silent[0]).searchParams.getAll("path"), [], "no path is asked before a file link");
  assert.equal(await dialog.locator('a[data-repo-ref="commit"], a[data-repo-ref="path"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: repo references link at 390x844: paths, commits, issues, board items; code blocks and buttons stay plain;"
    + " a failed check is not asked in a loop, a silent provider is asked no path");
} finally {
  await browser.close();
}
