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
  vm.runInNewContext(code, { exports, require: (id) => id.startsWith("./") ? load(id.slice(2)) : require(id), Error, Object, Date, Array, Set, Map, JSON, Number, String }, { filename: name });
  return exports;
}
const { isHidden, outboxAfter, patchAnswered, outboxText, outboxKey, listWithStart, failureFor, answerLanded, mayHaveLanded, failureText, ANSWER_TIMEOUT_MS, clickFor, needsRecheck, keepsFailedCard } = load("answer-outbox");

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
assert.deepEqual({ ...box["q-2"] }, { state: "failed", kind: "decline", draft: { text: "Wrong premise." }, error: "close refused", uncertain: false });
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

// ---- After a failure that may have been written, the item tells (review M1, I3; re-check Important 1) ----
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
  // The page gives up before the board does: the answer may still be saved (re-check Minor 1).
  assert.equal(failureText(timeout), `The board did not answer within ${ANSWER_TIMEOUT_MS / 1000} s; your answer may still be saved: check the item before answering again.`);
  assert.equal(failureText(server), "Your answer is saved; closing failed: try again.");
  assert.equal(failureText(refusal), refusal.message);
  assert.equal(ANSWER_TIMEOUT_MS, 30000);
}
console.log("PASS answer outbox: which failures are checked against the item, and their words");

// ---- Landed: this click's answer, never someone else's close (re-check Important 1, Minor 2) ----
{
  const ACTOR = "human:me";
  const CLICK = Date.parse("2026-11-10T12:00:00Z");
  const t = (s) => new Date(CLICK + s * 1000).toISOString();
  const sent = (comment) => ({ at: CLICK, comment, actor: ACTOR });
  const closed = (close_reason, extra = {}) => ({ id: "q-1", status: "closed", close_reason, closed_at: t(1), labels: ["human"], metadata: {}, ...extra });
  const mine = (text, s = 1) => [{ author: ACTOR, text, created_at: t(s) }];
  // A comment answer: closed with its reason, and the actor's newest comment is the text after the click.
  for (const kind of ["respond", "answers"]) {
    assert.equal(answerLanded(kind, closed("Responded"), mine("Use blue."), sent("Use blue.")), true, kind);
    assert.equal(answerLanded(kind, closed("Responded"), [{ author: "manager:box/m", text: "Ship on Friday.", created_at: t(1) }], sent("Use blue.")), false, `${kind}: a manager's answer closed it`);
    assert.equal(answerLanded(kind, closed("Responded"), mine("Other words."), sent("Use blue.")), false, `${kind}: other words`);
    assert.equal(answerLanded(kind, closed("Responded"), mine("Use blue.", -60), sent("Use blue.")), false, `${kind}: the same words from before the click`);
    assert.equal(answerLanded(kind, closed("Responded"), [...mine("Use blue."), ...mine("Later.", 2)], sent("Use blue.")), false, `${kind}: a newer comment of the actor`);
    assert.equal(answerLanded(kind, closed("Dismissed"), mine("Use blue."), sent("Use blue.")), false, `${kind}: closed as another reason`);
    assert.equal(answerLanded(kind, { id: "q-1", status: "open", labels: ["human"] }, mine("Use blue."), sent("Use blue.")), false, `${kind}: still open`);
    // Keep-open mode: open, the human label gone, and the actor's comment after the click.
    assert.equal(answerLanded(kind, { id: "q-1", status: "open", labels: ["question"] }, mine("Use blue."), sent("Use blue.")), true, `${kind}: keep-open`);
    assert.equal(answerLanded(kind, { id: "q-1", status: "open", labels: ["question"] }, mine("Other."), sent("Use blue.")), false, `${kind}: keep-open, other words`);
  }
  // A clock skew of a few seconds still counts.
  assert.equal(answerLanded("respond", closed("Responded"), mine("Use blue.", -4), sent("Use blue.")), true, "within the allowed skew");
  // Dismiss and Decline: closed with the reason, at or after the click, by the actor when the record says who.
  for (const [kind, reason] of [["dismiss", "Dismissed"], ["decline", "Declined"]]) {
    assert.equal(answerLanded(kind, closed(reason), [], sent(null)), true, kind);
    assert.equal(answerLanded(kind, closed(reason, { closed_at: t(-60) }), [], sent(null)), false, `${kind}: closed before the click`);
    assert.equal(answerLanded(kind, closed(reason, { closed_by: "manager:box/m" }), [], sent(null)), false, `${kind}: closed by another actor`);
    assert.equal(answerLanded(kind, closed(reason, { closed_by: ACTOR }), [], sent(null)), true, `${kind}: closed by the actor`);
    assert.equal(answerLanded(kind, closed("Responded"), [], sent(null)), false, `${kind}: another reason`);
  }
  // To Review: the record, at or after the click, by the actor.
  const reviewed = (review, at, by = ACTOR) => closed("Responded", { metadata: { "board.review": review, "board.reviewed_at": at, "board.reviewed_by": by } });
  assert.equal(answerLanded("accept", reviewed("accepted", t(1)), [], sent(null)), true);
  assert.equal(answerLanded("accept", reviewed("accepted", t(-60)), [], sent(null)), false, "an older acceptance");
  assert.equal(answerLanded("accept", reviewed("accepted", t(1), "human:other"), [], sent(null)), false, "another reviewer");
  assert.equal(answerLanded("reverse", reviewed("reversed", t(1)), [], sent(null)), true);
  assert.equal(answerLanded("reverse", reviewed("pending", t(1)), [], sent(null)), false);
  assert.equal(answerLanded("respond", null, [], sent("x")), false);
}
console.log("PASS answer outbox: an answer counts as landed only when the item shows this click's answer");

// ---- The click time: a retry of the same answer keeps it (re-check Important 2) ----
{
  assert.equal(clickFor(undefined, "a", 1000), 1000);
  assert.equal(clickFor({ fingerprint: "a", at: 500 }, "a", 1000), 500, "the same answer again: its first click");
  assert.equal(clickFor({ fingerprint: "a", at: 500 }, "b", 1000), 1000, "another answer: a new click");
}
console.log("PASS answer outbox: a retry of the same answer keeps its click time");

// ---- A failure that may still be written, and the card of an item closed meanwhile (re-check Important 1, Minor 1) ----
{
  const key = "q-1";
  let box = outboxAfter({}, { type: "send", id: key, kind: "respond", draft: { text: "x" } });
  box = outboxAfter(box, { type: "failed", id: key, error: "timed out", uncertain: true });
  assert.equal(box[key].uncertain, true);
  // The board settles the item later: an uncertain failure is checked again, a certain one is not.
  assert.equal(needsRecheck(box[key], { status: "closed", labels: ["human"] }), true);
  assert.equal(needsRecheck(box[key], { status: "open", labels: ["question"] }), true, "keep-open: the label went");
  assert.equal(needsRecheck(box[key], { status: "open", labels: ["human"] }), false, "still waiting");
  assert.equal(needsRecheck({ ...box[key], uncertain: false }, { status: "closed", labels: ["human"] }), false);
  // The check finds this click's answer: the failure becomes sent; else it is settled (certain).
  assert.equal(outboxAfter(box, { type: "sent", id: key, at: 2000 })[key].state, "sent");
  assert.equal(outboxAfter(box, { type: "settled", id: key })[key].uncertain, false);
  assert.equal(outboxAfter(box, { type: "settled", id: key })[key].state, "failed");
  // A failed answer keeps its card, also when the item left the inbox meanwhile (someone else closed it).
  assert.equal(keepsFailedCard(box[key]), true);
  assert.equal(keepsFailedCard({ state: "failed", kind: "accept", error: "e" }), false, "To Review keeps its own rows");
  assert.equal(keepsFailedCard({ state: "sending", kind: "respond" }), false);
  assert.equal(keepsFailedCard(undefined), false);
}
console.log("PASS answer outbox: an uncertain failure is checked again when the item settles; a failed answer keeps its card");
