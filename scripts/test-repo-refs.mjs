// Pure tests of the repo reference rules (lib/repo-refs.ts) and the Markdown
// plugin that applies them (remarkRepoRefs, same file). No server, no board data:
//   node scripts/test-repo-refs.mjs
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import {
  findRefs, toRepoPath, pathCandidates, wholeRef, parseGithubSlug, fillFileLink, isSafeRefHref, MAX_PATHS_PER_TEXT, remarkRepoRefs,
} from "../lib/repo-refs.ts";

const files = new Set(["agentwatch/daemon/no_dump.py", "README.md", "docs/a b.md", ".github/workflows/ci.yml"]);
const beads = new Set(["age-36g", "age-411.14"]);
const ctx = {
  github: { owner: "agentwatch-sh", repo: "agentwatch" },
  isFile: (p) => (p.startsWith("unknown/") ? undefined : files.has(p)),
  fileHref: ({ path, line, column }) => fillFileLink("/board-file/selden/age?path={path}&line={line}&col={column}", { path, line, column }),
  isBead: (id) => beads.has(id),
  beadHref: (id) => `/board/p/age?bead=${encodeURIComponent(id)}`,
};
const kinds = (text, c = ctx) => findRefs(text, c).map((r) => [r.kind, text.slice(r.start, r.end), r.href]);

// --- Rule 1: a repo file path, with :LINE, ~LINE or :LINE:COL ---------------
assert.deepEqual(kinds("see agentwatch/daemon/no_dump.py:68 now"), [
  ["path", "agentwatch/daemon/no_dump.py:68", "/board-file/selden/age?path=agentwatch%2Fdaemon%2Fno_dump.py&line=68&col="],
]);
assert.deepEqual(kinds("(agentwatch/daemon/no_dump.py~68)"), [
  ["path", "agentwatch/daemon/no_dump.py~68", "/board-file/selden/age?path=agentwatch%2Fdaemon%2Fno_dump.py&line=68&col="],
]);
assert.deepEqual(kinds("agentwatch/daemon/no_dump.py:68:5, then README.md."), [
  ["path", "agentwatch/daemon/no_dump.py:68:5", "/board-file/selden/age?path=agentwatch%2Fdaemon%2Fno_dump.py&line=68&col=5"],
  ["path", "README.md", "/board-file/selden/age?path=README.md&line=&col="],
]);
assert.deepEqual(kinds("./README.md and .github/workflows/ci.yml").map((k) => k[1]), ["./README.md", ".github/workflows/ci.yml"]);
// A path that does not exist, or whose existence is still unknown, is plain text.
assert.deepEqual(kinds("agentwatch/daemon/gone.py:3 and unknown/x.py"), []);
// Never a path: absolute, home, parent, a URL, a key store, a version, a word.
for (const text of ["/etc/passwd", "~/x/README.md", "../README.md", "docs/../README.md", "https://example.com/README.md",
  ".ssh/id_rsa", "x/.gnupg/key.md", "1.2.3", "word", "a//b.md"]) {
  assert.deepEqual(kinds(text, { ...ctx, isFile: () => true }), [], text);
}
assert.equal(toRepoPath("./agentwatch/x.py"), "agentwatch/x.py");
assert.equal(toRepoPath("Makefile"), null, "a bare word without a dot or a slash is not a path");
assert.equal(toRepoPath(".env"), ".env");
assert.deepEqual(pathCandidates("x.py:12 and y/z.ts~4").map((c) => [c.path, c.line, c.column]), [["x.py", 12, null], ["y/z.ts", 4, null]]);
// No file-link template: no path links (plain Scotty without agentwatch).
assert.deepEqual(kinds("README.md", { ...ctx, fileHref: null }), []);
// Unknown paths are collected so the caller can ask for them, and none links meanwhile.
{
  const unknown = new Set();
  assert.deepEqual(findRefs("unknown/a.py and unknown/b.py:3 and README.md", ctx, unknown).map((r) => r.kind), ["path"]);
  assert.deepEqual([...unknown], ["unknown/a.py", "unknown/b.py"]);
  const many = new Set();
  findRefs(Array.from({ length: 200 }, (_, i) => `unknown/f${i}.py`).join(" "), ctx, many);
  assert.equal(many.size, MAX_PATHS_PER_TEXT, "one text asks for a bounded number of paths");
}

// --- Rule 2: commits and issues go to GitHub ---------------------------------
assert.deepEqual(kinds("fixed in 55e6b91, see 76ab1ebf0c."), [
  ["commit", "55e6b91", "https://github.com/agentwatch-sh/agentwatch/commit/55e6b91"],
  ["commit", "76ab1ebf0c", "https://github.com/agentwatch-sh/agentwatch/commit/76ab1ebf0c"],
]);
assert.deepEqual(kinds("full 55e6b91b152df6978ab7ed5dca01f30bdd5b9b3b sha").map((k) => k[0]), ["commit"]);
// Not a commit: too short, too long, letters only, digits only, upper case, a
// hex word inside a longer word, a UUID part, a file name, a path, a 0x number.
for (const text of ["abc1234567890abcdef1234567890abcdef12345678 (41)", "a1b2c3", "deadbeefcafe", "20261112",
  "ABC1234", "x55e6b91", "55e6b91x", "550e8400-e29b-41d4-a716-446655440000", "55e6b91.md", "55e6b91/x", "0x55e6b91",
  "the decade began", "a facade"]) {
  assert.deepEqual(kinds(text).filter((k) => k[0] === "commit"), [], text);
}
assert.deepEqual(kinds("issue #654 and (#12)."), [
  ["issue", "#654", "https://github.com/agentwatch-sh/agentwatch/issues/654"],
  ["issue", "#12", "https://github.com/agentwatch-sh/agentwatch/issues/12"],
]);
assert.deepEqual(kinds("upstream brendan-appstart/bead-me-up-scotty#95 lands"), [
  ["issue", "brendan-appstart/bead-me-up-scotty#95", "https://github.com/brendan-appstart/bead-me-up-scotty/issues/95"],
]);
for (const text of ["PR#12", "a#12", "#0", "#12abc", "C#", "x/#12", "&#38;", "##12"]) {
  assert.deepEqual(kinds(text).filter((k) => k[0] === "issue"), [], text);
}
// A project with no GitHub remote links no commits and no issues.
assert.deepEqual(kinds("55e6b91 #654 owner/repo#3", { ...ctx, github: null }), []);

// --- Rule 3: an item id of this board ----------------------------------------
assert.deepEqual(kinds("blocked by age-36g and age-411.14."), [
  ["bead", "age-36g", "/board/p/age?bead=age-36g"],
  ["bead", "age-411.14", "/board/p/age?bead=age-411.14"],
]);
assert.deepEqual(kinds("age-999 x-age-36g age-36g-b"), [], "only whole ids of this board");
assert.deepEqual(kinds("age-36g", { ...ctx, isBead: undefined }), []);

// --- All together, in their own places ----------------------------------------
assert.deepEqual(kinds("README.md:3 fixes #9 in 55e6b91 for age-36g").map((k) => k[0]), ["path", "issue", "commit", "bead"]);

// --- Inline code: the whole content must be one reference ---------------------
assert.equal(wholeRef(" agentwatch/daemon/no_dump.py:68 ", ctx)?.kind, "path");
assert.equal(wholeRef("55e6b91", ctx)?.kind, "commit");
assert.equal(wholeRef("git show 55e6b91", ctx), null);
assert.equal(wholeRef("age-36g", ctx)?.kind, "bead");

// --- GitHub slug and the file link -------------------------------------------
assert.deepEqual(parseGithubSlug("agentwatch-sh/agentwatch"), { owner: "agentwatch-sh", repo: "agentwatch" });
for (const bad of [null, "", "a", "a/b/c", "a/..", "-a/b", "a b/c", 7]) assert.equal(parseGithubSlug(bad), null, String(bad));
assert.equal(fillFileLink("/f?path={path}&line={line}", { path: "a b/c#d.md", line: null, column: null }), "/f?path=a%20b%2Fc%23d.md&line=");
for (const bad of ["//evil.example/{path}", "javascript:alert(1)//{path}", "/\\evil/{path}", "relative/{path}", ""]) {
  assert.equal(fillFileLink(bad, { path: "README.md", line: 1, column: null }), null, bad);
}
assert.equal(fillFileLink("https://box.example/f?p={path}", { path: "README.md", line: 1, column: null }), "https://box.example/f?p=README.md");
assert.equal(isSafeRefHref("/board/p/age?bead=age-36g"), true);
assert.equal(isSafeRefHref("//evil.example/x"), false);
assert.equal(isSafeRefHref("javascript:alert(1)"), false);
console.log("PASS repo refs: paths, commits, issues, board ids, inline code, the file link");

// --- The Markdown plugin -------------------------------------------------------
function links(markdown, c = ctx, unknown) {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRepoRefs, { ctx: c, unknown });
  const tree = processor.runSync(processor.parse(markdown));
  const out = [];
  (function walk(node, inCode) {
    if (node.type === "link") {
      const text = node.children.map((child) => child.value ?? child.children?.map((x) => x.value).join("")).join("");
      out.push({ url: node.url, text, ref: node.data?.hProperties?.dataRepoRef ?? null, code: node.children[0]?.type === "inlineCode" });
    }
    for (const child of node.children ?? []) walk(child, inCode || node.type === "code");
  })(tree, false);
  return out;
}
const md = [
  "See agentwatch/daemon/no_dump.py:68 and `README.md` and `55e6b91`, #654, age-36g.",
  "",
  "```",
  "agentwatch/daemon/no_dump.py:68 55e6b91 #654 age-36g",
  "```",
  "",
  "    README.md in an indented block",
  "",
  "A [README.md link](https://example.com/README.md) and https://github.com/x/y/commit/55e6b91 stay as they are.",
  "",
  "| File | Commit |",
  "| --- | --- |",
  "| README.md | 55e6b91 |",
  "",
  "`git show 55e6b91` stays code.",
].join("\n");
const found = links(md);
assert.deepEqual(found.map((l) => [l.ref, l.text, l.code]), [
  ["path", "agentwatch/daemon/no_dump.py:68", false],
  ["path", "README.md", true],
  ["commit", "55e6b91", true],
  ["issue", "#654", false],
  ["bead", "age-36g", false],
  [null, "README.md link", false],
  [null, "https://github.com/x/y/commit/55e6b91", false],
  ["path", "README.md", false],
  ["commit", "55e6b91", false],
], "fenced and indented code stays plain; links stay as written; tables link");
// No context at all: nothing changes.
assert.deepEqual(links("README.md 55e6b91 #654 age-36g", { github: null }), []);
// Unknown paths are reported by the plugin too.
{
  const unknown = new Set();
  links("unknown/q.py and `unknown/r.py`", ctx, unknown);
  assert.deepEqual([...unknown].sort(), ["unknown/q.py", "unknown/r.py"]);
}
console.log("PASS remark repo refs: text, inline code, fenced code, links, tables");

// --- The provider source: one context fetch, batched path checks, a cache ---
{
  const { RefsSource, REFS_TTL_MS } = await import("../lib/repo-refs.ts");
  const calls = [];
  let now = 1_000_000;
  let fail = false;
  const fetcher = async (url) => {
    calls.push(url);
    if (fail) return { ok: false, json: async () => ({}) };
    const asked = new URL(url, "https://box.example").searchParams.getAll("path");
    return { ok: true, json: async () => ({ s: "ok", data: { github: "agentwatch-sh/agentwatch",
      file_link: "/board-file/selden/age?path={path}&line={line}&col={column}", files: asked.filter((p) => files.has(p)) } }) };
  };
  const later = [];
  const source = new RefsSource("/api/board/refs/selden/age", { fetcher, now: () => now, schedule: (fn) => later.push(fn) });
  let bumps = 0;
  source.subscribe(() => { bumps += 1; });
  assert.equal(source.github, null, "nothing is known before the first answer");
  await source.ready;
  assert.deepEqual(source.github, { owner: "agentwatch-sh", repo: "agentwatch" });
  assert.equal(source.fileHref({ path: "README.md", line: 3, column: null }), "/board-file/selden/age?path=README.md&line=3&col=");
  assert.equal(calls.length, 1);
  assert.equal(source.isFile("README.md"), undefined);
  source.request(["README.md", "nope.md", "README.md"]);
  source.request(["agentwatch/daemon/no_dump.py"]);
  assert.equal(calls.length, 1, "paths wait for one batch");
  later.shift()();
  await source.idle();
  assert.equal(calls.length, 2, "one request for the batch");
  assert.deepEqual(new URL(calls[1], "https://box.example").searchParams.getAll("path"), ["README.md", "nope.md", "agentwatch/daemon/no_dump.py"]);
  assert.equal(source.isFile("README.md"), true);
  assert.equal(source.isFile("nope.md"), false);
  assert.ok(bumps >= 2, "subscribers hear each answer");
  source.request(["README.md"]);
  assert.equal(later.length, 0, "a known path is not asked again");
  now += REFS_TTL_MS + 1;
  assert.equal(source.isFile("README.md"), true, "a stale answer still shows");
  source.request(["README.md"]);
  assert.equal(later.length, 1, "a stale path is asked again");
  fail = true;
  later.shift()();
  await source.idle();
  assert.equal(source.isFile("README.md"), true, "a failed check keeps the last answer");
  assert.deepEqual(source.github, { owner: "agentwatch-sh", repo: "agentwatch" }, "a failed check keeps the context");
  // A source whose provider never answers links nothing.
  const dead = new RefsSource("/x", { fetcher: async () => { throw new Error("down"); }, now: () => now, schedule: (fn) => fn() });
  await dead.ready;
  assert.equal(dead.github, null);
  assert.equal(dead.fileHref({ path: "README.md", line: null, column: null }), null);
  // A provider that names a bad link or repo is ignored.
  const bad = new RefsSource("/x", { fetcher: async () => ({ ok: true, json: async () => ({ data: { github: "a/b/c", file_link: "//evil/{path}", files: [] } }) }), now: () => now, schedule: (fn) => fn() });
  await bad.ready;
  assert.equal(bad.github, null);
  assert.equal(bad.fileHref({ path: "README.md", line: null, column: null }), null);
  console.log("PASS refs source: context, batching, cache, stale answers, failures");
}

// --- A failed answer starts no request loop (review of age-62v) ---------------
// The renderer asks for its unknown paths after every render, and an answer
// renders again. A failed answer must change nothing (no render) and a failed
// path waits a backoff (REFS_RETRY_MS, doubling, at most REFS_TTL_MS) before it
// is asked again; a provider with no file link has no path asked at all.
{
  const { RefsSource, REFS_TTL_MS, REFS_RETRY_MS, retryDelay, sourceRefContext } = await import("../lib/repo-refs.ts");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(retryDelay),
    [REFS_RETRY_MS, 2 * REFS_RETRY_MS, 4 * REFS_RETRY_MS, 8 * REFS_RETRY_MS, REFS_TTL_MS, REFS_TTL_MS, REFS_TTL_MS]);
  const render = (source, text, extra = {}) => {
    // What DescriptionContent does: the context from the source, a render, then request(unknown).
    const unknown = new Set();
    links(text, { ...sourceRefContext(source), isBead: ctx.isBead, beadHref: ctx.beadHref, ...extra }, unknown);
    if (source && unknown.size) source.request(unknown);
    return unknown;
  };
  const TEXT = "See README.md and agentwatch/daemon/no_dump.py:68, then 55e6b91.";
  const CONTEXT = { github: "agentwatch-sh/agentwatch", file_link: "/f?path={path}&line={line}&col={column}", files: [] };
  const asked = (url) => new URL(url, "https://box.example").searchParams.getAll("path");

  // 1. A fetcher that always fails, asked again after every round.
  {
    let now = 5_000_000;
    let calls = 0;
    const failing = new RefsSource("/x", { fetcher: async () => { calls += 1; return { ok: false, json: async () => ({}) }; },
      now: () => now, schedule: (fn) => fn() });
    let bumps = 0;
    failing.subscribe(() => { bumps += 1; });
    await failing.ready;
    for (let round = 0; round < 500; round += 1) {
      failing.request(["README.md", "nope.md"]);
      await failing.idle();
    }
    assert.equal(calls, 2, "the context once and the paths once while no time passes");
    assert.equal(bumps, 0, "a failure changes nothing, so it renders nothing");
    // 300 s of rounds, 100 ms apart: asked again at +5, +15, +35, +75, +135, +195 and +255 s.
    for (let round = 0; round < 3000; round += 1) {
      now += 100;
      failing.request(["README.md", "nope.md"]);
      await failing.idle();
    }
    assert.equal(calls, 2 + 7, "a bounded number of asks: the backoff grows to REFS_TTL_MS");
    assert.equal(bumps, 0);
  }

  // 2. The context answers; every path check fails (a 502, a 401, the gateway gone).
  //    Rounds of render + request, each answer rendering again, as the page does.
  for (const failure of ["status", "throw", "no-links"]) {
    let now = 7_000_000;
    let pathCalls = 0;
    const source = new RefsSource("/y", {
      fetcher: async (url) => {
        if (!asked(url).length) return { ok: true, json: async () => ({ s: "ok", data: CONTEXT }) };
        pathCalls += 1;
        if (failure === "throw") throw new Error("down");
        if (failure === "status") return { ok: false, json: async () => ({ s: "error" }) };
        // The gateway's no-links answer: the daemon is gone for now.
        return { ok: true, json: async () => ({ s: "ok", data: { github: null, file_link: null, files: [] } }) };
      },
      now: () => now, schedule: (fn) => fn(),
    });
    let renders = 0;
    source.subscribe(() => { renders += 1; });
    await source.ready;
    assert.equal(renders, 1, "the context answer renders once");
    for (let round = 0; round < 500; round += 1) {
      render(source, TEXT);
      await source.idle();
    }
    assert.equal(pathCalls, 1, `${failure}: one path check, not a loop`);
    assert.equal(renders, 1, `${failure}: a failed check renders nothing`);
    assert.deepEqual(source.github, { owner: "agentwatch-sh", repo: "agentwatch" }, `${failure}: the context stays`);
    assert.equal(source.fileLink, CONTEXT.file_link, `${failure}: the file link stays`);
    now += retryDelay(1);
    render(source, TEXT);
    await source.idle();
    assert.equal(pathCalls, 2, `${failure}: asked again after the backoff`);
  }

  // 3. A stale answer whose refresh fails keeps showing and waits the backoff too.
  //    (The renderer collects only unknown paths; a stale one is asked by request().)
  {
    let now = 9_000_000;
    let fail = false;
    let pathCalls = 0;
    const source = new RefsSource("/z", {
      fetcher: async (url) => {
        const paths = asked(url);
        if (!paths.length) return { ok: true, json: async () => ({ data: CONTEXT }) };
        pathCalls += 1;
        if (fail) return { ok: false, json: async () => ({}) };
        // A path batch answer may leave out the repo (the provider reads the remotes only for the context).
        return { ok: true, json: async () => ({ data: { file_link: CONTEXT.file_link, files: paths.filter((p) => files.has(p)) } }) };
      },
      now: () => now, schedule: (fn) => fn(),
    });
    await source.ready;
    render(source, TEXT);
    await source.idle();
    assert.equal(source.isFile("README.md"), true);
    assert.deepEqual(source.github, { owner: "agentwatch-sh", repo: "agentwatch" }, "a path answer without github keeps the repo");
    let renders = 0;
    source.subscribe(() => { renders += 1; });
    render(source, TEXT);
    await source.idle();
    assert.equal(pathCalls, 1, "fresh answers are not asked again");
    now += REFS_TTL_MS + 1;
    fail = true;
    for (let round = 0; round < 200; round += 1) {
      render(source, TEXT);
      source.request(["README.md", "agentwatch/daemon/no_dump.py"]);
      await source.idle();
    }
    assert.equal(pathCalls, 2, "a stale path whose refresh failed waits the backoff");
    assert.equal(source.isFile("README.md"), true, "the stale answer still shows");
    assert.equal(renders, 0);
    // The same answer again changes nothing: no render.
    fail = false;
    now += REFS_TTL_MS + 1;
    source.request(["README.md", "agentwatch/daemon/no_dump.py"]);
    await source.idle();
    assert.equal(pathCalls, 3);
    assert.equal(renders, 0, "an answer that changes nothing renders nothing");
  }

  // 4. A provider that never answered collects no paths: nothing to ask.
  {
    const hanging = new RefsSource("/never", { fetcher: () => new Promise(() => {}), schedule: (fn) => fn() });
    const failed = new RefsSource("/failed", { fetcher: async () => { throw new Error("down"); }, schedule: (fn) => fn() });
    await failed.ready;
    const empty = new RefsSource("/empty", { fetcher: async () => ({ ok: true, json: async () => ({ data: { github: null, file_link: null, files: [] } }) }),
      schedule: (fn) => fn() });
    await empty.ready;
    for (const source of [hanging, failed, empty, null]) {
      assert.deepEqual(sourceRefContext(source), { github: null, isFile: null, fileHref: null });
      assert.equal(render(source, TEXT).size, 0, "no path is collected before a file link is known");
    }
    // The links that need no provider still work.
    assert.deepEqual(links("age-36g and README.md", { ...sourceRefContext(hanging), isBead: ctx.isBead, beadHref: ctx.beadHref })
      .map((l) => l.ref), ["bead"]);
    // A context with a file link collects them.
    const ready = new RefsSource("/ok", { fetcher: async () => ({ ok: true, json: async () => ({ data: CONTEXT }) }), schedule: () => {} });
    await ready.ready;
    assert.deepEqual([...render(ready, TEXT)].sort(), ["README.md", "agentwatch/daemon/no_dump.py"]);
  }
  console.log("PASS refs source: no request loop after a failure; no paths before a file link");
}
