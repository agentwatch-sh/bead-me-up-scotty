// One answer takes one slot of the board's bd queue (agentwatch board age-6mk).
// Pure checks with a fake bd that logs its calls: the exact calls of a Needs You
// answer, and a list request made during an answer runs its export after the
// close, never between the answer's steps. No server, no board, no bd.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import util from "node:util";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(name, stubs, cache = new Map()) {
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const code = ts.transpileModule(fs.readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const resolve = (id) => (id in stubs ? stubs[id] : id.startsWith("./") ? load(id.slice(2), stubs, cache) : require(id));
  vm.runInNewContext(code, { exports, require: resolve, process, console, Error, Object, Date, Array, Map, Set, Promise, JSON, String, Number, TextEncoder, setTimeout }, { filename: name });
  return exports;
}

// ---- A fake bd: each call takes a few ms and is logged when it starts and ends ----
const log = [];
let item;
const fail = new Set();
function fakeExecFile() { throw new Error("only the promisified form is used"); }
fakeExecFile[util.promisify.custom] = async (bin, args) => {
  const call = [...args]; // a copy in this realm: the module runs in a vm context
  log.push(["start", call]);
  await new Promise((done) => setTimeout(done, 15));
  log.push(["end", call]);
  if (fail.has(call[0])) {
    const error = new Error("bd failed");
    error.stderr = JSON.stringify({ error: `${call[0]} refused`, code: "refused" });
    throw error;
  }
  if (call[0] === "show") return { stdout: JSON.stringify({ data: [item] }), stderr: "" };
  if (call[0] === "export") return { stdout: JSON.stringify(item) + "\n", stderr: "" };
  if (call[0] === "close") item = { ...item, status: "closed", close_reason: call[3] };
  return { stdout: "", stderr: "" };
};
const stubs = { "server-only": {}, "node:child_process": { execFile: fakeExecFile } };
const cache = new Map();
const { createBdStore } = load("bd", stubs, cache);
const { answerHuman } = load("human-answer", stubs, cache);
const store = createBdStore("/nonexistent-repo");

const ACTOR = "human:test";
const question = (metadata = {}) => ({ id: "q-1", title: "Q", status: "open", issue_type: "task", priority: 2, labels: ["human", "question"], metadata });
const calls = () => log.filter(([at]) => at === "start").map(([, c]) => c);
const reset = (metadata) => { log.length = 0; fail.clear(); item = question(metadata); };
const answer = (body, keepOpen = false) => answerHuman(store, "q-1", body, { actor: ACTOR, keepOpen, log: () => {} });

// Respond: show (validate), comment, close, show (the response). No show after the comment.
reset();
let result = await answer({ action: "respond", text: "Use blue." });
assert.equal(result.ok, true);
assert.equal(result.bead.status, "closed");
assert.deepEqual(calls(), [["show", "q-1", "--json"], ["comment", "q-1", "--", "Use blue."], ["close", "q-1", "--reason", "Responded"], ["show", "q-1", "--json"]]);

// A bare Dismiss writes no comment.
reset();
result = await answer({ action: "dismiss" });
assert.deepEqual(calls(), [["show", "q-1", "--json"], ["close", "q-1", "--reason", "Dismissed"], ["show", "q-1", "--json"]]);

// A decline: its comment, then the close as Declined.
reset();
result = await answer({ action: "decline", text: "The premise is wrong." });
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "close", "show"]);
assert.deepEqual(calls()[2], ["close", "q-1", "--reason", "Declined"]);

// A refused answer reads the item and writes nothing.
reset();
item = { ...item, status: "closed" };
result = await answer({ action: "dismiss", text: "Late." });
assert.equal(result.ok, false);
assert.equal(result.code, "stale_question");
assert.deepEqual(calls(), [["show", "q-1", "--json"]]);

// An item with a manager's review record: the cleanup comes after the close, then one show.
reset({ "board.review": "pending", "board.review_by": "manager:box/m", "board.review_reason": "r", "board.acked": "true" });
result = await answer({ action: "respond", text: "Mine." });
assert.deepEqual(calls(), [["show", "q-1", "--json"], ["comment", "q-1", "--", "Mine."], ["close", "q-1", "--reason", "Responded"],
  ["update", "q-1", "--unset-metadata", "board.review", "--unset-metadata", "board.review_by", "--unset-metadata", "board.review_reason", "--unset-metadata", "board.acked"],
  ["show", "q-1", "--json"]]);
// A failed cleanup keeps the answer: the close stands, and the response is the item.
reset({ "board.review": "pending" });
fail.add("update");
result = await answer({ action: "dismiss" });
assert.equal(result.ok, true);
assert.equal(result.bead.status, "closed");
assert.deepEqual(calls().map((c) => c[0]), ["show", "close", "update", "show"]);

// SCOTTY_HUMAN_RESPOND=keep-open: the label goes, the item stays open.
reset();
result = await answer({ action: "respond", text: "Open." }, true);
assert.deepEqual(calls(), [["show", "q-1", "--json"], ["comment", "q-1", "--", "Open."], ["update", "q-1", "--remove-label", "human"], ["show", "q-1", "--json"]]);

// A failed close fails the answer: the error reaches the route, nothing runs after it.
reset();
fail.add("close");
await assert.rejects(answer({ action: "respond", text: "Use blue." }), /close refused/);
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "close"]);
console.log("PASS human answer calls: show, comment, close, show; no show after the comment; review cleanup; keep-open; refusals");

// ---- A list made during an answer waits for the whole answer ----
reset();
const answering = answer({ action: "respond", text: "Use blue." });
// The list arrives while the answer's first call runs.
await new Promise((done) => setTimeout(done, 5));
const listing = store.list();
const [answered, listed] = await Promise.all([answering, listing]);
assert.equal(answered.ok, true);
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "close", "show", "export"]);
// Nothing overlaps: each call ends before the next one starts.
for (let i = 0; i < log.length; i += 2) {
  assert.equal(log[i][0], "start");
  assert.equal(log[i + 1][0], "end");
  assert.deepEqual(log[i + 1][1], log[i][1]);
}
assert.equal(listed[0].status, "closed", "the list made during the answer shows the item closed");
console.log("PASS one slot per answer: a list made during an answer runs its export after the close");
