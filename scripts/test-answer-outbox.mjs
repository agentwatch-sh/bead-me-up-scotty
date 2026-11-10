// Pure checks of the answer outbox rules (agentwatch board age-6mk): an answered item
// leaves its list at the click, stays out while an older list arrives, and comes back
// with its error and its draft when the write fails. No server or board data required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(name) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: (id) => id.startsWith("./") ? load(id.slice(2)) : require(id), Error, Object, Date, Array, Set, Map, JSON }, { filename: name });
  return exports;
}
const { isHidden, outboxAfter, patchAnswered, outboxText, outboxKey, listWithStart, failureFor, answerLanded, mayHaveLanded, failureText, ANSWER_TIMEOUT_MS } = load("answer-outbox");

// The click: the item leaves at once, whatever list is on screen.
let box = outboxAfter({}, { type: "send", id: "q-1", kind: "respond", draft: { text: "typed" } });
assert.equal(box["q-1"].state, "sending");
assert.equal(isHidden(box["q-1"], undefined), true);
assert.equal(isHidden(box["q-1"], Date.now() + 60_000), true, "no list brings back an item whose write runs");

// The 2xx at time 1000: a list requested before it is older and keeps the item out; a list
// requested after it is the board's word.
box = outboxAfter(box, { type: "sent", id: "q-1", at: 1000 });
assert.equal(box["q-1"].state, "sent");
assert.equal(box["q-1"].draft, undefined, "a saved answer keeps no draft");
assert.equal(isHidden(box["q-1"], undefined), true);
assert.equal(isHidden(box["q-1"], 999), true, "an older list during or after the POST does not bring it back");
assert.equal(isHidden(box["q-1"], 1000), true);
assert.equal(isHidden(box["q-1"], 1001), false, "a list requested after the 2xx shows the board as it is");

// A failure: the item is back with its error and the draft it was sent with.
box = outboxAfter({}, { type: "send", id: "q-2", kind: "decline", draft: { text: "Wrong premise." } });
box = outboxAfter(box, { type: "failed", id: "q-2", error: "close refused" });
assert.deepEqual({ ...box["q-2"] }, { state: "failed", kind: "decline", draft: { text: "Wrong premise." }, error: "close refused" });
assert.equal(isHidden(box["q-2"], undefined), false);
assert.equal(isHidden(box["q-2"], 0), false);
// A new send replaces the failure; a cleared failure is gone.
assert.equal(outboxAfter(box, { type: "send", id: "q-2", kind: "decline", draft: { text: "x" } })["q-2"].state, "sending");
assert.equal(outboxAfter(box, { type: "clear", id: "q-2" })["q-2"], undefined);
// A result for an item that is not sending (cleared meanwhile) changes nothing.
assert.equal(outboxAfter({}, { type: "sent", id: "q-9", at: 5 })["q-9"], undefined);
assert.equal(outboxAfter({}, { type: "failed", id: "q-9", error: "e" })["q-9"], undefined);
// Release: a queued item that never went (Accept all stopped) comes back as it was.
box = outboxAfter({}, { type: "send", id: "r-1", kind: "accept" });
assert.equal(outboxAfter(box, { type: "release", id: "r-1" })["r-1"], undefined);
// The reducer never changes the box it was given.
// A frozen box would throw on a write; the result is a new object, and the input is as it was.
const frozen = Object.freeze({ "q-3": Object.freeze({ state: "sending", kind: "respond", draft: Object.freeze({ text: "t" }) }) });
const before = JSON.parse(JSON.stringify(frozen));
for (const event of [{ type: "sent", id: "q-3", at: 1 }, { type: "failed", id: "q-3", error: "e" }, { type: "release", id: "q-3" }, { type: "send", id: "q-4", kind: "dismiss" }]) {
  const after = outboxAfter(frozen, event);
  assert.notEqual(after, frozen, `${event.type} gives a new box`);
  assert.deepEqual(frozen, before, `${event.type} leaves the given box as it was`);
}
assert.equal(outboxAfter(frozen, { type: "sent", id: "q-3", at: 1 })["q-3"].state, "sent");
console.log("PASS answer outbox: out at the click, out while an older list arrives, back with the error and the draft");

// The cache patch after the 2xx: the answer's own fields, never the comments the
// list holds (`bd show` leaves them out).
const list = { beads: [
  { id: "q-1", title: "Q", status: "open", labels: ["human"], comments: [{ text: "c" }], metadata: { a: 1 } },
  { id: "q-2", title: "Other", status: "open", labels: ["human"], comments: [] },
], meta: {} };
const shown = { id: "q-1", title: "Q", status: "closed", close_reason: "Responded", closed_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:00:00Z", labels: ["human", "question"], metadata: { a: 2 }, comments: [] };
const patched = patchAnswered(list, shown);
assert.notEqual(patched, list);
assert.equal(patched.beads[0].status, "closed");
assert.equal(patched.beads[0].close_reason, "Responded");
assert.deepEqual(patched.beads[0].metadata, { a: 2 });
assert.deepEqual(patched.beads[0].comments, [{ text: "c" }], "the list's comments stay");
assert.equal(patched.beads[1], list.beads[1], "other items are untouched");
assert.equal(patchAnswered(list, { warning: "x" }), list, "a body with no item changes nothing");
assert.equal(patchAnswered(undefined, shown), undefined);
assert.equal(patchAnswered(list, { ...shown, id: "q-404" }), list);
console.log("PASS answer outbox: the 2xx patches the answered item's status fields only");

// The words: "Sending…" at the click, a short confirmation after the 2xx.
for (const kind of ["respond", "dismiss", "decline", "answers", "accept", "reverse"]) {
  const text = outboxText(kind, "q-1");
  assert.match(text.sending, /^Sending .*q-1…$/, kind);
  assert.match(text.done, /q-1$/, kind);
}
assert.equal(outboxText("respond", "q-1").done, "Responded to q-1");
assert.equal(outboxText("accept", "q-1").done, "Accepted the answer to q-1");
console.log("PASS answer outbox: Sending… at the click, a confirmation after the 2xx");

// ---- The start of a list request, and the 2xx: which list is older (review M4) ----
{
  let clock = 1000;
  let resolve;
  const listing = listWithStart(() => new Promise((done) => { resolve = done; }), () => clock);
  clock = 3000; // the list answers later; its start is what counts
  resolve({ beads: [], meta: {} });
  const list = await listing;
  assert.equal(list.startedAt, 1000, "the start is taken before the request, not when it answers");
  assert.deepEqual(list.beads, []);
  // An answer whose 2xx came at 2000: the list requested at 1000 is older, even though it arrived at 3000.
  const sent = { state: "sent", kind: "respond", at: 2000 };
  assert.equal(isHidden(sent, list.startedAt), true);
  clock = 2500;
  const newer = await listWithStart(async () => ({ beads: [], meta: {} }), () => clock);
  assert.equal(isHidden(sent, newer.startedAt), false, "a list requested after the 2xx shows the board as it is");
}
console.log("PASS answer outbox: a list's start is taken before it is requested; the older one keeps the item out");

// ---- Two projects with the same item id (review M3) ----
{
  const a = outboxKey("alpha", "q-1");
  const b = outboxKey("beta", "q-1");
  assert.notEqual(a, b);
  assert.notEqual(outboxKey("a/b", "c"), outboxKey("a", "b/c"), "the key cannot be forged by a slash");
  const box = outboxAfter({}, { type: "send", id: a, kind: "respond" });
  assert.equal(isHidden(box[a], undefined), true);
  assert.equal(isHidden(box[b], undefined), false, "an answer in one project never hides the same id in another");
}
console.log("PASS answer outbox: entries are kept per project");

// ---- An error shows only for its own kind (review M2) ----
{
  const failed = { state: "failed", kind: "accept", error: "refused", draft: undefined };
  assert.equal(failureFor(failed, ["accept"]), failed);
  assert.equal(failureFor(failed, ["reverse"]), undefined, "an Accept's error never shows in the Reverse form");
  assert.equal(failureFor(failed, ["respond", "dismiss", "decline", "answers"]), undefined);
  assert.equal(failureFor({ state: "sending", kind: "accept" }, ["accept"]), undefined);
  assert.equal(failureFor(undefined, ["accept"]), undefined);
}
console.log("PASS answer outbox: an error shows only in the form of its own kind");

// ---- After a failure that may have been written, the item tells (review M1, I3) ----
{
  const network = new TypeError("Failed to fetch");
  const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  const server = Object.assign(new Error("Your answer is saved; closing failed: try again."), { status: 500, code: "answer_saved_close_failed" });
  const gateway = Object.assign(new Error("board backend unavailable"), { status: 502 });
  const refusal = Object.assign(new Error("This question is no longer waiting for an answer."), { status: 409, code: "stale_question" });
  const login = Object.assign(new Error("password login required"), { status: 403 });
  for (const e of [network, timeout, aborted, server, gateway]) assert.equal(mayHaveLanded(e), true, e.message);
  for (const e of [refusal, login]) assert.equal(mayHaveLanded(e), false, `${e.message}: a refusal wrote nothing`);
  assert.match(failureText(network), /did not reach the board/);
  assert.match(failureText(aborted), /did not reach the board/);
  assert.equal(failureText(timeout), `The board did not answer within ${ANSWER_TIMEOUT_MS / 1000} s. Try again.`);
  assert.equal(failureText(server), "Your answer is saved; closing failed: try again.");
  assert.equal(failureText(refusal), refusal.message);
  assert.equal(ANSWER_TIMEOUT_MS, 30000);
  const closed = (close_reason, metadata = {}) => ({ id: "q-1", status: "closed", close_reason, metadata });
  assert.equal(answerLanded("respond", closed("Responded")), true);
  assert.equal(answerLanded("answers", closed("Responded")), true);
  assert.equal(answerLanded("dismiss", closed("Dismissed")), true);
  assert.equal(answerLanded("decline", closed("Declined")), true);
  assert.equal(answerLanded("respond", closed("Dismissed")), false, "another close is not this answer");
  assert.equal(answerLanded("respond", { id: "q-1", status: "open" }), false);
  assert.equal(answerLanded("accept", closed("Responded", { "board.review": "accepted" })), true);
  assert.equal(answerLanded("accept", closed("Responded", { "board.review": "pending" })), false);
  assert.equal(answerLanded("reverse", closed("Responded", { "board.review": "reversed" })), true);
  assert.equal(answerLanded("reverse", closed("Responded", { "board.review": "pending" })), false);
  assert.equal(answerLanded("respond", null), false);
}
console.log("PASS answer outbox: a failure that may have been written is checked against the item");
