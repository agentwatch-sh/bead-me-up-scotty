// One answer takes one slot of the board's bd queue (agentwatch board age-6mk).
// Pure checks with a fake bd that logs its calls: the exact calls of a Needs You
// answer and of a To Review Accept and Reverse, a list request made during an
// answer runs its export after it, an answer is written once also when it is sent
// again after a failed close, and every bd call has a time limit, so a hung step
// releases the slot. The last part runs a real child process (a sleeping fake bd
// in a temporary folder); no server, no board, no bd.
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
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

const ACTOR = "human:test";
const MANAGER = "manager:box/m";

// ---- A fake bd on one item: each call takes a few ms, is logged when it starts and ends ----
const log = [];
const options = [];
let item;
const fail = new Set();
let now = 0;
// A fake clock in seconds, for the comments' times: at() takes the next second.
const iso = (s) => new Date(Date.UTC(2026, 10, 10, 12, 0, 0) + s * 1000).toISOString();
const at = () => iso(now++);
const shown = () => ({ ...item, comments: undefined, comment_count: item.comments.length });
function fakeExecFile() { throw new Error("only the promisified form is used"); }
fakeExecFile[util.promisify.custom] = async (bin, args, opts) => {
  const call = [...args]; // a copy in this realm: the module runs in a vm context
  options.push({ timeout: opts?.timeout });
  log.push(["start", call]);
  await new Promise((done) => setTimeout(done, 15));
  log.push(["end", call]);
  // A command fails when named; "mark" fails only the click's mark, "cleanup" only an unset of metadata.
  const isMark = call[0] === "update" && call.some((a) => a.startsWith("scotty.answer_click="));
  const isCleanup = call[0] === "update" && call.includes("--unset-metadata");
  if (fail.has(call[0]) || (isMark && fail.has("mark")) || (isCleanup && fail.has("cleanup"))) {
    const error = new Error("bd failed");
    error.stderr = JSON.stringify({ error: `${call[0]} refused`, code: "refused" });
    throw error;
  }
  const actor = opts?.env?.BEADS_ACTOR;
  switch (call[0]) {
    case "show": return { stdout: JSON.stringify({ data: [shown()] }), stderr: "" };
    case "comments": return { stdout: JSON.stringify({ data: item.comments }), stderr: "" };
    case "export": return { stdout: JSON.stringify(shown()) + "\n", stderr: "" };
    case "comment": item = { ...item, comments: [...item.comments, { author: actor, text: call.slice(3).join(" "), created_at: at() }] }; break;
    case "close": item = { ...item, status: "closed", close_reason: call[3], closed_at: at() }; break;
    case "reopen": item = { ...item, status: "open", close_reason: null, closed_at: null }; break;
    case "update": {
      const metadata = { ...(item.metadata ?? {}) };
      let labels = item.labels;
      for (let i = 2; i < call.length; i += 2) {
        if (call[i] === "--unset-metadata") delete metadata[call[i + 1]];
        if (call[i] === "--set-metadata") { const [k, ...v] = call[i + 1].split("="); metadata[k] = v.join("="); }
        if (call[i] === "--remove-label") labels = labels.filter((l) => l !== call[i + 1]);
      }
      item = { ...item, metadata, labels };
      break;
    }
  }
  return { stdout: "", stderr: "" };
};
const stubs = { "server-only": {}, "node:child_process": { execFile: fakeExecFile } };
const cache = new Map();
const { createBdStore } = load("bd", stubs, cache);
const { answerHuman } = load("human-answer", stubs, cache);
const { answerReview } = load("review-answer", stubs, cache);
const store = createBdStore("/nonexistent-repo");

const question = (metadata = {}, comments = []) => ({ id: "q-1", title: "Q", status: "open", issue_type: "task", priority: 2, labels: ["human", "question"], metadata, comments });
const calls = () => log.filter(([at]) => at === "start").map(([, c]) => c);
const reset = (metadata, comments) => { log.length = 0; options.length = 0; fail.clear(); item = question(metadata, comments); };
// Each answer carries the id of its click (click_id), as the page sends it; null sends none.
const CLICK = "click-a";
const answer = (body, keepOpen = false, clickId = CLICK) =>
  answerHuman(store, "q-1", clickId === null ? body : { ...body, click_id: clickId }, { actor: ACTOR, keepOpen, log: () => {} });
const mine = () => item.comments.filter((c) => c.author === ACTOR);
const mark = (id = CLICK) => ["update", "q-1", "--set-metadata", `scotty.answer_click=${id}`];

// Respond: show (validate), comment, the click's mark, close, show (the response).
reset();
let result = await answer({ action: "respond", text: "Use blue." });
assert.equal(result.ok, true);
assert.equal(result.bead.status, "closed");
assert.deepEqual(calls(), [["show", "q-1", "--json"], ["comment", "q-1", "--", "Use blue."], mark(), ["close", "q-1", "--reason", "Responded"], ["show", "q-1", "--json"]]);
assert.equal(item.metadata["scotty.answer_click"], CLICK);

// A bare Dismiss writes no comment; its mark comes before the close.
reset();
result = await answer({ action: "dismiss" });
assert.deepEqual(calls(), [["show", "q-1", "--json"], mark(), ["close", "q-1", "--reason", "Dismissed"], ["show", "q-1", "--json"]]);

// A decline: its comment, the mark, then the close as Declined.
reset();
result = await answer({ action: "decline", text: "The premise is wrong." });
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "update", "close", "show"]);
assert.deepEqual(calls()[3], ["close", "q-1", "--reason", "Declined"]);

// A page that sends no click id (an older build): the answer is written, with no mark.
reset();
result = await answer({ action: "respond", text: "Use blue." }, false, null);
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "close", "show"]);

// A refused answer reads the item and writes nothing.
reset();
item = { ...item, status: "closed" };
result = await answer({ action: "dismiss", text: "Late." });
assert.equal(result.ok, false);
assert.equal(result.code, "stale_question");
assert.deepEqual(calls(), [["show", "q-1", "--json"]]);

// An item with a manager's review record: the cleanup comes after the close, then one show.
reset({ "board.review": "pending", "board.review_by": MANAGER, "board.review_reason": "r", "board.acked": "true" });
result = await answer({ action: "respond", text: "Mine." });
assert.deepEqual(calls(), [["show", "q-1", "--json"], ["comment", "q-1", "--", "Mine."], mark(), ["close", "q-1", "--reason", "Responded"],
  ["update", "q-1", "--unset-metadata", "board.review", "--unset-metadata", "board.review_by", "--unset-metadata", "board.review_reason", "--unset-metadata", "board.acked"],
  ["show", "q-1", "--json"]]);
// A failed cleanup keeps the answer: the close stands, and the response is the item.
reset({ "board.review": "pending" });
fail.add("cleanup");
result = await answer({ action: "dismiss" });
assert.equal(result.ok, true);
assert.equal(result.bead.status, "closed");
assert.deepEqual(calls().map((c) => c[0]), ["show", "update", "close", "update", "show"]);

// SCOTTY_HUMAN_RESPOND=keep-open: the label goes, the item stays open.
reset();
result = await answer({ action: "respond", text: "Open." }, true);
assert.deepEqual(calls(), [["show", "q-1", "--json"], ["comment", "q-1", "--", "Open."], mark(), ["update", "q-1", "--remove-label", "human"], ["show", "q-1", "--json"]]);
console.log("PASS human answer calls: show, comment, the click's mark, close, show; review cleanup; keep-open; no click id; refusals");

// ---- An answer is written once per click: the click id, no clocks (re-check rv-6mk-c) ----
const BODY = { action: "respond", text: "Use blue." };
// A failed close after the comment: the answer and its mark are saved, and the route says so.
reset();
fail.add("close");
result = await answer(BODY);
assert.deepEqual({ ...result }, { ok: false, status: 500, code: "answer_saved_close_failed", error: "Your answer is saved; closing failed: try again." });
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "update", "close"]);
assert.equal(mine().length, 1);
// A retry of the same click, whenever it comes: the mark is this click's, so it only closes.
fail.clear();
log.length = 0;
result = await answer(BODY);
assert.equal(result.ok, true);
assert.deepEqual(calls().map((c) => c[0]), ["show", "close", "show"]);
assert.equal(mine().length, 1, "one answer comment after the failed close and the retry");
// The first try finished but its response was lost: the retry finds a closed item and is stale
// (re-check rv-6mk-d: no "this click closed it" inference), with no write.
log.length = 0;
result = await answer(BODY);
assert.equal(result.code, "stale_question");
assert.deepEqual(calls().map((c) => c[0]), ["show"], "no write");
assert.equal(mine().length, 1);
// An edited answer is a new click: its comment is written, also over an earlier click's saved comment.
reset();
fail.add("close");
await answer(BODY);
fail.clear();
log.length = 0;
result = await answer({ action: "respond", text: "Use green." }, false, "click-b");
assert.equal(result.ok, true);
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "update", "close", "show"]);
assert.deepEqual(mine().map((c) => c.text), ["Use blue.", "Use green."]);
assert.equal(item.metadata["scotty.answer_click"], "click-b");
// A later answer with the same words (the agent reopened and asked again) is a new click: written.
reset({ "scotty.answer_click": CLICK }, [{ author: ACTOR, text: "Use blue.", created_at: at() }, { author: "agent:a", text: "Are you sure?", created_at: at() }]);
await answer(BODY, false, "click-c");
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "update", "close", "show"]);
// The mark fails after the comment: the close is skipped, and the route says the answer is saved;
// a retry then writes the comment again (the known limit). (re-check rv-6mk-d, Minor 1)
reset();
fail.add("mark");
result = await answer(BODY);
assert.equal(result.code, "answer_saved_close_failed");
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "update"], "no close without the mark");
assert.equal(item.status, "open");
// A bare Dismiss whose mark fails saved nothing: bd's error, and no close.
reset();
fail.add("mark");
await assert.rejects(answer({ action: "dismiss" }), /update refused/);
assert.deepEqual(calls().map((c) => c[0]), ["show", "update"]);
// A bare Dismiss saved no answer: its failed close fails the request as bd failed.
reset();
fail.add("close");
await assert.rejects(answer({ action: "dismiss" }), /close refused/);
// A failed comment saved nothing: bd's error.
reset();
fail.add("comment");
await assert.rejects(answer(BODY), /comment refused/);
console.log("PASS human answer once: a retry of the same click on an open item only closes; a closed one is stale; an edited or later answer is a new click; no close without the mark");

// ---- A closed or done item is stale for every answer, also with this click's mark (re-check rv-6mk-d) ----
// The route never infers "this click closed it": the mark comes before the close, and another
// writer can close in between. A retry on a closed or done item is stale, as every other answer.
const closedAs = (reason, metadata = {}) => { reset(metadata); item = { ...item, status: "closed", close_reason: reason, closed_at: at() }; };
// Every kind of answer, a tapped choice and a group too: the closed check comes before any shape check.
const CHOICE = { action: "respond", choice: { version: 1, id: "blue", label: "Use blue", description: "Blue.", recommended: true }, text: "Use blue" };
const GROUP = { action: "respond", answers: [{ id: "q1", question: "Theme?", header: "Theme", multiSelect: false, action: "responded", choices: null, text: "Blue." }], text: "Blue." };
const ANSWERS = [BODY, { action: "dismiss", text: "Fine." }, { action: "decline", text: "No." }, { action: "dismiss" }, CHOICE, GROUP];
for (const metadata of [{}, { "scotty.answer_click": CLICK }, { "scotty.answer_click": "click-z" }]) {
  for (const body of ANSWERS) {
    closedAs("Responded", metadata);
    const refused = await answer(body);
    const name = `${body.action}${body.text ? " with words" : ""}, mark ${metadata["scotty.answer_click"] ?? "none"}`;
    assert.equal(refused.code, "stale_question", name);
    assert.deepEqual(calls().map((c) => c[0]), ["show"], `${name}: no comment, no mark, no close`);
  }
}
// Keep-open done (the label gone), with or without this click's mark: stale.
for (const metadata of [{}, { "scotty.answer_click": CLICK }]) {
  for (const body of ANSWERS) {
    reset(metadata);
    item = { ...item, labels: ["question"] };
    assert.equal((await answer(body, true)).code, "stale_question", `keep-open ${body.action}`);
    assert.deepEqual(calls().map((c) => c[0]), ["show"]);
  }
}
// A bare Dismiss on an item that is not waiting (no human label, or deferred): stale, no mark, no close.
for (const change of [{ labels: ["question"] }, { status: "deferred" }]) {
  reset();
  item = { ...item, ...change };
  assert.equal((await answer({ action: "dismiss" })).code, "stale_question", JSON.stringify(change));
  assert.deepEqual(calls().map((c) => c[0]), ["show"]);
}
// A manager's answer that waits for review points to To Review.
closedAs("Responded", { "scotty.answer_click": CLICK, "board.review": "pending" });
assert.equal((await answer(BODY)).code, "manager_answered");
console.log("PASS human answer: a closed or done item is stale for every answer, a bare Dismiss and this click's mark too");

// ---- A list made during an answer waits for the whole answer ----
reset();
const answering = answer({ action: "respond", text: "Use blue." });
// The list arrives while the answer's first call runs.
await new Promise((done) => setTimeout(done, 5));
const listing = store.list();
const [answered, listed] = await Promise.all([answering, listing]);
assert.equal(answered.ok, true);
assert.deepEqual(calls().map((c) => c[0]), ["show", "comment", "update", "close", "show", "export"]);
// Nothing overlaps: each call ends before the next one starts.
for (let i = 0; i < log.length; i += 2) {
  assert.equal(log[i][0], "start");
  assert.equal(log[i + 1][0], "end");
  assert.deepEqual(log[i + 1][1], log[i][1]);
}
assert.equal(listed[0].status, "closed", "the list made during the answer shows the item closed");
console.log("PASS one slot per answer: a list made during an answer runs its export after the close");

// ---- To Review: Accept and Reverse take one slot too, and carry the click's mark ----
const reviewed = (metadata = {}) => {
  reset({ "board.review": "pending", "board.review_by": MANAGER, "board.review_reason": "Blue.", ...metadata }, [{ author: MANAGER, text: "Use blue.", created_at: at() }]);
  item = { ...item, status: "closed", close_reason: "Responded", closed_at: at() };
};
const review = (body, clickId = CLICK) => answerReview(store, "q-1", clickId === null ? body : { ...body, click_id: clickId }, { actor: ACTOR, now: () => "2026-11-10T12:00:00Z", log: () => {} });
reviewed();
let reviewing = review({ action: "accept" });
await new Promise((done) => setTimeout(done, 5));
let [accepted, afterAccept] = await Promise.all([reviewing, store.list()]);
assert.equal(accepted.ok, true);
assert.equal(accepted.bead.metadata["board.review"], "accepted");
assert.equal(accepted.bead.metadata["scotty.answer_click"], CLICK, "the Accept carries the click's mark, in its review write");
assert.deepEqual(calls().map((c) => c[0]), ["show", "comments", "update", "show", "export"]);
assert.equal(afterAccept[0].metadata["board.review"], "accepted", "the list made during the Accept runs after it");
// A retry of the same click after a lost response: the review is in place, so it is not pending (no inference).
log.length = 0;
const again = await review({ action: "accept" });
assert.equal(again.code, "not_pending");
assert.deepEqual(calls().map((c) => c[0]), ["show", "comments"], "no write");
reviewed();
reviewing = review({ action: "reverse", answer: { action: "respond", text: "Use green." } });
await new Promise((done) => setTimeout(done, 5));
const [reversed, afterReverse] = await Promise.all([reviewing, store.list()]);
assert.equal(reversed.ok, true);
assert.equal(reversed.bead.metadata["board.review"], "reversed");
assert.equal(reversed.bead.metadata["scotty.answer_click"], CLICK, "the Reverse carries the click's mark, in its review record");
assert.equal(calls().at(-1)[0], "export", "the list made during the Reverse runs after all of its steps");
assert.equal(afterReverse[0].metadata["board.review"], "reversed");
for (let i = 0; i < log.length; i += 2) assert.deepEqual(log[i + 1][1], log[i][1], "no step of the Reverse overlaps another call");
// A refusal reads and writes nothing more; another click's Accept is not this one.
reviewed({ "board.review": "accepted", "scotty.answer_click": "click-z" });
const refused = await review({ action: "accept" });
assert.equal(refused.ok, false);
assert.equal(refused.code, "not_pending");
assert.deepEqual(calls().map((c) => c[0]), ["show", "comments"]);
console.log("PASS one slot per review: a list made during an Accept or a Reverse runs after it; the click's mark; a retry is not pending");

// ---- Every bd call has a time limit ----
assert.ok(options.length > 0 && options.every((o) => o.timeout === 60000), "every bd call runs with a 60 s execFile timeout");
console.log("PASS bd time limit: every call has the 60 s execFile timeout");

// ---- A hung step releases the slot (a real child process, a short limit) ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scotty-slot-timeout-"));
const saved = { BD_BIN: process.env.BD_BIN, SCOTTY_BD_TIMEOUT_MS: process.env.SCOTTY_BD_TIMEOUT_MS };
try {
  const bin = path.join(dir, "bd");
  const row = JSON.stringify({ id: "q-1", title: "Q", status: "open", issue_type: "task", priority: 2, labels: ["human", "question"], comment_count: 0 });
  // A bd that hangs on close and answers everything else at once. (The limit stops
  // the BD_BIN process only: a wrapper's own child is not stopped; see lib/bd.ts.)
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  close) echo $$ >> "$(dirname "$0")/pids"; exec sleep 30 ;;\n  show) printf '%s\\n' '{"data":[${row}]}' ;;\n  export) printf '%s\\n' '${row}' ;;\nesac\nexit 0\n`, { mode: 0o755 });
  process.env.BD_BIN = bin;
  process.env.SCOTTY_BD_TIMEOUT_MS = "400";
  const real = new Map();
  const realStubs = { "server-only": {}, "node:child_process": childProcess };
  const timed = load("bd", realStubs, real).createBdStore(dir);
  const { answerHuman: realAnswer } = load("human-answer", realStubs, real);
  const started = Date.now();
  const slow = realAnswer(timed, "q-1", { action: "respond", text: "Use blue." }, { actor: ACTOR, keepOpen: false, log: () => {} });
  const after = timed.list();
  const result = await slow;
  assert.deepEqual({ ...result }, { ok: false, status: 500, code: "answer_saved_close_failed", error: "Your answer is saved; closing failed: try again." });
  const rows = await after;
  assert.equal(rows[0].id, "q-1", "the list queued behind the hung step runs");
  assert.ok(Date.now() - started < 5000, `the slot was released after the time limit (${Date.now() - started} ms)`);
  await assert.rejects(timed.inOneSlot((s) => s.close("q-1", ACTOR, "Responded")), (e) => e.code === "bd_timeout" && /did not finish within 0.4 s/.test(e.message) && !e.message.includes("Use blue"));
  // Each hung bd (its pid stays the same through exec) was stopped: none is left.
  const pids = fs.readFileSync(path.join(dir, "pids"), "utf8").trim().split("\n").map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `the hung bd ${pid} is gone`);
  console.log("PASS bd time limit: a hung close times out with bd_timeout, its bd is stopped, and the slot is released");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
