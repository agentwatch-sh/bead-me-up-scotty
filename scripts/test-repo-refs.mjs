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
