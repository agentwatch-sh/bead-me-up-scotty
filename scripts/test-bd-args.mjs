// Free text reaches bd as text, never as a flag (agentwatch #605).
// Pure checks of the argv lib/bd.ts builds, with a fake execFile; then, when bd
// is installed, the same writes on a throwaway board in a temporary folder
// (its own HOME, removed at the end). Never a live board.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(name, stubs) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const resolve = (id) => (id in stubs ? stubs[id] : id.startsWith("./") ? load(id.slice(2), stubs) : require(id));
  vm.runInNewContext(code, { exports, require: resolve, process, Error, Object, Date, Array, Map, Promise, JSON, String, Number }, { filename: name });
  return exports;
}

// ---- The argv, with a fake bd ----
const calls = [];
const bead = { id: "t-1", title: "T", status: "open", issue_type: "task", priority: 2, labels: [] };
function fakeExecFile() { throw new Error("only the promisified form is used"); }
fakeExecFile[util.promisify.custom] = async (bin, args) => {
  calls.push([...args]); // a copy in this realm: the module runs in a vm context
  if (args[0] === "show") return { stdout: JSON.stringify({ data: [bead] }), stderr: "" };
  if (args[0] === "create") return { stdout: JSON.stringify({ data: { id: "t-1" } }), stderr: "" };
  return { stdout: "", stderr: "" };
};
const fake = load("bd", { "server-only": {}, "node:child_process": { execFile: fakeExecFile } });
const store = fake.createBdStore("/nonexistent-repo");

const ACTOR = "human:test";
const sneaky = ["--file=/etc/hostname", "-x", "--actor=agent:evil", "--db=/tmp/other", "-C/tmp", "--", "plain words"];
for (const text of sneaky) {
  calls.length = 0;
  await store.addComment("t-1", text, ACTOR);
  assert.deepEqual(calls[0], ["comment", "t-1", "--", text], `the comment ${JSON.stringify(text)} comes after --`);
}
for (const title of sneaky) {
  calls.length = 0;
  await store.create({ title, issue_type: "task", priority: 2 }, ACTOR);
  const args = calls[0];
  assert.equal(args[0], "create");
  assert.equal(args[1], `--title=${title}`, `the title ${JSON.stringify(title)} is the value of --title`);
  assert.ok(!args.slice(2).includes(title), "the title is not also a positional argument");
}
console.log("PASS bd argv: a comment goes after --, a title is the value of --title=");

// ---- The same writes on a throwaway board, when bd is installed ----
const bin = process.env.SCOTTY_TEST_BD || process.env.BD_BIN || "bd";
try {
  execFileSync(bin, ["--version"], { stdio: "ignore" });
} catch {
  console.log("SKIP bd argv on a board: bd is not installed");
  process.exit(0);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scotty-bd-args-"));
const saved = { HOME: process.env.HOME, BEADS_ACTOR: process.env.BEADS_ACTOR, BD_BIN: process.env.BD_BIN };
try {
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  // A file whose text must never reach a comment: --file=<it> is text, not a read.
  const secret = path.join(dir, "secret.txt");
  fs.writeFileSync(secret, "do-not-read-me\n");
  // bd keeps state in HOME: the board's own HOME keeps it in the folder.
  process.env.HOME = home;
  process.env.BD_BIN = bin;
  delete process.env.BEADS_ACTOR;
  const env = { ...process.env };
  execFileSync("git", ["init", "-q"], { cwd: repo, env });
  execFileSync(bin, ["init", "--prefix", "ba", "-q"], { cwd: repo, env, stdio: "ignore" });
  const real = load("bd", { "server-only": {}, "node:child_process": childProcess }).createBdStore(repo);

  const texts = [`--file=${secret}`, "-x", "--actor=agent:evil", "--", "ordinary text"];
  for (const title of texts) {
    const created = await real.create({ title, issue_type: "task", priority: 2 }, ACTOR);
    assert.equal(created.title, title, `the title ${JSON.stringify(title)} is kept as typed`);
  }
  const target = (await real.create({ title: "comments", issue_type: "task", priority: 2 }, ACTOR)).id;
  for (const text of texts) await real.addComment(target, text, ACTOR);
  const comments = await real.comments(target);
  assert.deepEqual([...comments.map((c) => c.text)], texts, "each comment is the text as typed");
  assert.ok(comments.every((c) => c.author === ACTOR), "--actor= in a text never sets the author");
  assert.ok(comments.every((c) => !c.text.includes("do-not-read-me")), "--file= in a text never reads a file");
  console.log("PASS bd argv on a board: --file=, -x, --actor= and -- are kept as text");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
