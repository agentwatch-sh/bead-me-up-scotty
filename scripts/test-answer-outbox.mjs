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
  vm.runInNewContext(code, { exports, require: (id) => id.startsWith("./") ? load(id.slice(2)) : require(id), Error, Object, Date, Array, Set, Map, JSON, Number, String, Uint8Array, Math, TextEncoder }, { filename: name });
  return exports;
}
const { isHidden, outboxAfter, patchAnswered, outboxText, outboxKey, listWithStart, failureFor, afterFailure, mayHaveLanded, failureText, ANSWER_TIMEOUT_MS, clickIdFor, newClickId, needsRecheck, keepsFailedCard, recheckStillCurrent, SAVED_TEXT, CLOSED_NOW_TEXT, holdsAnswer, answerRecord, noResponse } = load("answer-outbox");

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
assert.deepEqual({ ...box["q-2"] }, { state: "failed", kind: "decline", draft: { text: "Wrong premise." }, error: "close refused", uncertain: false, closedNow: false });
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
  assert.equal(failureText(timeout), "The board did not answer within 90 s; your answer may still be saved: check the item before answering again.");
  assert.equal(failureText(server), "Your answer is saved; closing failed: try again.");
  assert.equal(failureText(refusal), refusal.message);
  // One bd call may run 60 s (SCOTTY_BD_TIMEOUT_MS), and an answer runs several (age-7uad).
  assert.equal(ANSWER_TIMEOUT_MS, 90000);
}
console.log("PASS answer outbox: which failures are checked against the item, and their words");

// ---- After an uncertain failure: three cases, no inference of "sent" (re-check rv-6mk-d) ----
{
  const sent = { clickId: "click-a" };
  const item = (status, labels, metadata = {}) => ({ id: "q-1", status, labels, metadata });
  const marked = { "scotty.answer_click": "click-a" };
  for (const kind of ["respond", "answers", "dismiss", "decline"]) {
    // 1. Open, with this click's mark: saved, the close failed.
    assert.equal(afterFailure(kind, item("open", ["human"], marked), sent), "saved", kind);
    // 2. Open, without this click's mark: the failure as it is.
    assert.equal(afterFailure(kind, item("open", ["human"]), sent), "failed", kind);
    assert.equal(afterFailure(kind, item("open", ["human"], { "scotty.answer_click": "click-z" }), sent), "failed", `${kind}: another click`);
    // 3. Closed or done, by anyone, also with this click's mark: the neutral case, never "sent".
    assert.equal(afterFailure(kind, item("closed", ["human"], marked), sent), "closed", `${kind}: closed with the mark`);
    assert.equal(afterFailure(kind, item("closed", ["human"]), sent), "closed", `${kind}: closed by someone else`);
    assert.equal(afterFailure(kind, item("open", ["question"], marked), sent), "closed", `${kind}: keep-open done`);
  }
  // To Review: the review record in place of the close.
  const review = (value, metadata = {}) => item("closed", ["human"], { "board.review": value, ...metadata });
  for (const kind of ["accept", "reverse"]) {
    assert.equal(afterFailure(kind, review("pending"), sent), "failed", kind);
    // The mark comes with the review record, so a pending record with the mark is a stale mark: failed.
    assert.equal(afterFailure(kind, review("pending", marked), sent), "failed", `${kind}: pending, whatever the mark`);
    // A Reverse that failed half-way (reverse_incomplete): open again, no review key: failed, not "closed now".
    assert.equal(afterFailure(kind, item("open", ["human"], {}), sent), "failed", `${kind}: open again`);
    assert.equal(needsRecheck({ state: "failed", kind, error: "e", uncertain: true }, item("open", ["human"], {})), false, `${kind}: open again is not settled`);
    // Closed with no pending record: settled.
    assert.equal(afterFailure(kind, item("closed", ["human"], {}), sent), "closed", `${kind}: closed, no record`);
    assert.equal(afterFailure(kind, review("accepted", marked), sent), "closed", `${kind}: the record is in place`);
    assert.equal(afterFailure(kind, review("reversed"), sent), "closed", `${kind}: someone else's record`);
  }
  assert.equal(SAVED_TEXT, "Your answer is saved; closing failed: try again.");
  assert.equal(CLOSED_NOW_TEXT, "This question is closed now. Your answer may or may not be the one recorded: open the item to check.");
  assert.ok(!/Responded|Declined|Dismissed|not saved/.test(CLOSED_NOW_TEXT), "the neutral words claim nothing");
}
console.log("PASS answer outbox: after an uncertain failure, open+mark is saved, open is failed, closed or done is neutral");

// ---- The click id: a retry of the same answer keeps it; an edited answer is a new click ----
{
  let n = 0;
  const fresh = () => `id-${++n}`;
  assert.equal(clickIdFor(undefined, "a", fresh), "id-1");
  assert.equal(clickIdFor({ fingerprint: "a", clickId: "id-1" }, "a", fresh), "id-1", "the same answer again: its click");
  assert.equal(clickIdFor({ fingerprint: "a", clickId: "id-1" }, "b", fresh), "id-2", "an edited answer: a new click");
  // Without crypto.randomUUID (a page on plain HTTP): an id from getRandomValues; without either, still an id.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.equal(newClickId({ randomUUID: () => "from-random-uuid" }), "from-random-uuid");
  const viaValues = newClickId({ getRandomValues: (bytes) => { bytes.fill(171); return bytes; } });
  assert.match(viaValues, uuid);
  assert.match(newClickId({}), uuid);
  assert.notEqual(newClickId({}), newClickId({}));
}
console.log("PASS answer outbox: the click id; without randomUUID it comes from getRandomValues");

// ---- An uncertain failure is checked again when the item settles; a failed answer keeps its card ----
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
  // The check never makes it "sent": it takes the neutral words and is certain.
  const closed = outboxAfter(box, { type: "closedNow", id: key });
  assert.deepEqual([closed[key].state, closed[key].uncertain, closed[key].closedNow, closed[key].error], ["failed", false, true, CLOSED_NOW_TEXT]);
  assert.equal(closed[key].draft.text, "x", "the typed text stays");
  assert.equal(outboxAfter({}, { type: "closedNow", id: key })[key], undefined);
  // A failed answer keeps its card, also when the item left its list meanwhile.
  assert.equal(keepsFailedCard(box[key]), true);
  assert.equal(keepsFailedCard({ state: "failed", kind: "accept", error: "e" }), false, "a To Review failure keeps its row only when closed now");
  assert.equal(keepsFailedCard({ state: "failed", kind: "accept", error: "e", closedNow: true }), true);
  assert.equal(keepsFailedCard({ state: "sending", kind: "respond" }), false);
  assert.equal(keepsFailedCard(undefined), false);
}
console.log("PASS answer outbox: an uncertain failure is checked again when the item settles, into the neutral case; a failed answer keeps its card");
// ---- The recheck race: a check of an older try never confirms over a newer send (re-check rv-6mk-c, Minor 2) ----
{
  const older = { item: { id: "q-1" } };
  const newer = { item: { id: "q-1" } };
  const uncertain = { state: "failed", kind: "respond", error: "e", uncertain: true };
  assert.equal(recheckStillCurrent(older, older, uncertain), true);
  assert.equal(recheckStillCurrent(newer, older, uncertain), false, "the operator sent again meanwhile");
  assert.equal(recheckStillCurrent(older, older, { state: "sending", kind: "respond" }), false, "a new send runs");
  assert.equal(recheckStillCurrent(older, older, { ...uncertain, uncertain: false }), false, "already settled");
  assert.equal(recheckStillCurrent(older, older, undefined), false, "cleared");
}
console.log("PASS answer outbox: a recheck acts only when its try is still the item's latest, failed and uncertain");

// ---- A closed item that holds this answer: the answer is recorded (age-7uad) ----
// After a time limit or a lost response the item is found closed. The page compares the answer
// the item recorded (agentwatch's rule: the latest answer comment made at or before the close)
// with the one it sent: equal, the answer is recorded; different or unreadable, the neutral words.
{
  const { validateHumanAnswer } = load("human-validate");
  const { renderChoice, renderGroup, renderDecline } = load("human-choices");
  const ME = "human:selden";
  const MANAGER = "manager:taylor/aw-lead";
  const sent = { clickId: "click-a" };
  const T = (s) => `2026-11-18T10:00:${String(s).padStart(2, "0")}Z`;
  const mark = { "scotty.answer_click": "click-a" };
  // The item as the human route leaves it: the operator's comment, this click's mark, the close.
  const recorded = (text, over = {}) => ({ id: "q-1", status: "closed", close_reason: "Responded", closed_at: T(30), labels: ["human", "question"],
    metadata: { ...mark }, comments: text === null ? [] : [{ author: ME, text, created_at: T(29) }], ...over });
  const respond = { comment: "Ship it on Monday.", reason: "Responded" };

  // Equal: recorded.
  assert.equal(holdsAnswer(recorded("Ship it on Monday."), respond, sent, ME, false), true);
  // A discussion comment after the close (an agent, a manager or the operator) is not the answer.
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { comments: [{ author: ME, text: "Ship it on Monday.", created_at: T(29) },
    { author: "agent:test", text: "Thanks.", created_at: T(40) }, { author: MANAGER, text: "Noted.", created_at: T(41) }] }), respond, sent, ME, false), true);
  // An agent's comment before the close is no answer either (agentwatch's answer authors only).
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { comments: [{ author: ME, text: "Ship it on Monday.", created_at: T(20) },
    { author: "agent:test", text: "Working on it.", created_at: T(25) }] }), respond, sent, ME, false), true);

  // Different: the neutral words stay.
  assert.equal(holdsAnswer(recorded("Ship it on Friday."), respond, sent, ME, false), false, "another text");
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { comments: [{ author: ME, text: "Ship it on Monday.", created_at: T(20) },
    { author: MANAGER, text: "Ship it on Friday.", created_at: T(25) }] }), respond, sent, ME, false), false, "a manager's later answer is the one recorded");
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { comments: [{ author: MANAGER, text: "Ship it on Monday.", created_at: T(25) }] }), respond, sent, ME, false), false,
    "the same words by another author are not the operator's answer");
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { comments: [{ author: "link:mac/assistant", text: "Ship it on Monday.", created_at: T(25) }] }), respond, sent, ME, false), false);
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { close_reason: "Dismissed" }), respond, sent, ME, false), false, "another close reason");
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { metadata: {} }), respond, sent, ME, false), false, "no mark: this click's write is unknown");
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { metadata: { "scotty.answer_click": "click-z" } }), respond, sent, ME, false), false, "another click's mark");
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { metadata: { ...mark, "board.review": "pending" } }), respond, sent, ME, false), false, "a manager's answer waits for review");
  assert.equal(holdsAnswer(recorded("Ship it on Monday."), respond, sent, undefined, false), false, "the operator's actor is unknown");
  assert.equal(holdsAnswer(recorded(null), respond, sent, ME, false), false, "the item's comments are not there to read");
  assert.equal(holdsAnswer(recorded("Ship it on Monday.", { status: "open", close_reason: null, closed_at: null }), respond, sent, ME, false), false, "still waiting");
  assert.equal(holdsAnswer(recorded("Ship it on Monday."), undefined, sent, ME, false), false, "no record to compare (a To Review action)");
  // Done without a close (open, no human label) holds an answer only on a board that runs
  // SCOTTY_HUMAN_RESPOND=keep-open; agentwatch runs close mode and reads only closed items (fix 3).
  const doneOpen = recorded("Ship it on Monday.", { status: "open", close_reason: null, closed_at: null, labels: ["question"] });
  assert.equal(holdsAnswer(doneOpen, respond, sent, ME, true), true, "keep-open: done");
  assert.equal(holdsAnswer(doneOpen, respond, sent, ME, false), false, "close mode: an open item holds no answer");

  // Every kind of answer the human route writes: answerRecord gives the comment and the reason it writes.
  const blue = { version: 1, id: "blue", label: "Use blue", description: "Keep blue.", recommended: true };
  const green = { version: 1, id: "green", label: "Use green", description: "Make green.", recommended: false };
  // An option as the metadata holds it: the choice without its version.
  const options = [blue, green].map(({ id, label, description, recommended }) => ({ id, label, description, recommended }));
  const questions = [
    { id: "theme", question: "Which theme?", header: "Theme", multiSelect: false, options },
    { id: "format", question: "Which format?", header: "Format", multiSelect: false, options },
  ];
  const identity = (q) => ({ id: q.id, question: q.question, header: q.header, multiSelect: q.multiSelect });
  const group = [{ ...identity(questions[0]), action: "responded", choices: [green], text: null, note: "Keep the logo." },
    { ...identity(questions[1]), action: "responded", choices: null, text: "PDF only." }];
  const v1 = { "scotty.choices": { version: 1, options } };
  const v2 = { "scotty.choices": { version: 2, questions } };
  const open = (metadata = {}) => ({ id: "q-1", title: "Q", status: "open", labels: ["human", "question"], metadata, comments: [] });
  const bodies = [
    ["a free-text answer", open(), { action: "respond", text: "Ship it on Monday." }],
    ["a choice with a note", open(v1), { action: "respond", text: renderChoice(green, "Soon."), choice: green, note: "Soon." }],
    ["a decline", open(), { action: "decline", text: "The premise is wrong." }],
    ["a bare Dismiss", open(), { action: "dismiss" }],
    ["a Dismiss with a comment", open(), { action: "dismiss", text: "Not now." }],
    ["a Dismiss of a choice", open(v1), { action: "dismiss", choice: blue, text: renderChoice(blue) }],
    ["a group of answers (version 2)", open(v2), { action: "respond", answers: group, text: renderGroup(group) }],
  ];
  for (const [name, item, body] of bodies) {
    const verdict = validateHumanAnswer(item, body, { closedOk: false });
    assert.equal(verdict.ok, true, `${name}: ${JSON.stringify(verdict)}`);
    assert.deepEqual({ ...answerRecord(body) }, { comment: verdict.comment, reason: verdict.reason }, `${name}: the record is what the route writes`);
  }
  assert.equal(answerRecord({ action: "decline", text: "No." }).comment, renderDecline("No."));
  // A bare Dismiss writes no comment: recorded when no other author's answer is the item's.
  const dismissed = { comment: null, reason: "Dismissed" };
  assert.equal(holdsAnswer(recorded(null, { close_reason: "Dismissed" }), dismissed, sent, ME, false), true);
  assert.equal(holdsAnswer(recorded(null, { close_reason: "Dismissed", comments: [{ author: MANAGER, text: "Use blue.", created_at: T(25) }] }), dismissed, sent, ME, false), false);
  assert.equal(holdsAnswer(recorded(null, { close_reason: "Responded" }), dismissed, sent, ME, false), false);

  // Version 2: the comment holds every answer, and every answer is compared.
  const groupRecord = answerRecord({ action: "respond", answers: group, text: renderGroup(group) });
  assert.equal(holdsAnswer(recorded(renderGroup(group)), groupRecord, sent, ME, false), true, "the same answers");
  const otherSecond = [group[0], { ...group[1], text: "PDF and HTML." }];
  assert.equal(holdsAnswer(recorded(renderGroup(otherSecond)), groupRecord, sent, ME, false), false, "the second answer differs");
  const otherNote = [{ ...group[0], note: "Drop the logo." }, group[1]];
  assert.equal(holdsAnswer(recorded(renderGroup(otherNote)), groupRecord, sent, ME, false), false, "the first answer's note differs");
  const otherChoice = [{ ...group[0], choices: [blue] }, group[1]];
  assert.equal(holdsAnswer(recorded(renderGroup(otherChoice)), groupRecord, sent, ME, false), false, "the first answer's choice differs");
}
console.log("PASS answer outbox: a closed item holds this answer only with this click's mark, its close reason and the operator's same comment as its answer; every answer of a group is compared");

// ---- A recheck that finds this answer recorded: the failure becomes the confirmation (age-7uad) ----
{
  const key = "q-1";
  let box = outboxAfter({}, { type: "send", id: key, kind: "answers", draft: { q1: {} } });
  box = outboxAfter(box, { type: "failed", id: key, error: "timed out", uncertain: true });
  const done = outboxAfter(box, { type: "recorded", id: key, at: 5000 });
  assert.deepEqual({ ...done[key] }, { state: "sent", kind: "answers", at: 5000 });
  assert.equal(isHidden(done[key], 4000), true, "an older list keeps the item out");
  // Only an uncertain failure: a certain one, a closed-now card, a send that runs, nothing.
  for (const entry of [{ state: "failed", kind: "respond", error: "e", uncertain: false }, { state: "failed", kind: "respond", error: CLOSED_NOW_TEXT, closedNow: true },
    { state: "sending", kind: "respond" }, undefined]) {
    const from = entry ? { [key]: entry } : {};
    assert.equal(outboxAfter(from, { type: "recorded", id: key, at: 1 })[key], from[key]);
  }
}
console.log("PASS answer outbox: a recheck that finds this answer recorded turns the uncertain failure into the confirmation");

// ---- Only a try that got no response from the route may be confirmed from the item (age-7uad, fix 1) ----
// The gateway records the operator's answer only for the route's 2xx. A route that answered with an
// error (500 answer_saved_close_failed after a close that wrote, a bd_timeout) recorded none, so the
// page never says "recorded" for it; a dropped connection, the page's time limit or the tunnel's 524
// (no response from the route) may still have ended in the route's 2xx.
{
  const network = new TypeError("Failed to fetch");
  const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  const tunnel = Object.assign(new Error("Request failed (524)"), { status: 524 });
  for (const e of [network, timeout, aborted, tunnel]) assert.equal(noResponse(e), true, e.message);
  const saved = Object.assign(new Error(SAVED_TEXT), { status: 500, code: "answer_saved_close_failed" });
  const gateway = Object.assign(new Error("board backend unavailable"), { status: 502 });
  const starting = Object.assign(new Error("board backend starting; retry"), { status: 503 });
  const bdTimeout = Object.assign(new Error("bd timed out"), { status: 400, code: "bd_timeout" });
  const stale = Object.assign(new Error("This question is no longer waiting for an answer."), { status: 409, code: "stale_question" });
  for (const e of [saved, gateway, starting, bdTimeout, stale, undefined, null, "x"]) assert.equal(noResponse(e), false, String(e?.message ?? e));
}
console.log("PASS answer outbox: only a try with no response from the route (a dropped connection, the time limit, a 524) may be confirmed from the item");
