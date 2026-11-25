// Pure contract tests for lib/review.ts; no server or board data required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
// lib/review.ts imports extensionless siblings, which node cannot resolve: transpile like test-blocking.mjs.
const require = createRequire(import.meta.url);
function load(name) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: (id) => id.startsWith("./") ? load(id.slice(2)) : require(id), Error, Object, Date, Array, TextEncoder }, { filename: name });
  return exports;
}
const review = load("review");
const { reverseAnswer, ReverseError } = review;

const ME = "human:selden";
const needsReview = (b) => review.needsReview(b, ME);
const managerAnswer = (b) => review.managerAnswer(b, ME);
const latestAnswerAuthor = (b) => review.latestAnswerAuthor(b, ME);
const reviewCount = (bs) => review.reviewCount(bs, ME);
const T = (s) => `2026-11-02T10:00:${String(s).padStart(2, "0")}Z`;
const bead = (over = {}) => ({
  id: "x-1", title: "Q", status: "closed", closed_at: T(30), close_reason: "Responded", labels: ["human", "question"],
  metadata: { "board.review": "pending", "board.review_by": "manager:test/manager" },
  comments: [{ author: "manager:test/manager", text: "Use blue.", created_at: T(20) }],
  ...over,
});

assert.equal(needsReview(bead()), true);
assert.equal(latestAnswerAuthor(bead()), "manager:test/manager");
assert.deepEqual({ ...managerAnswer(bead()) }, { author: "manager:test/manager", text: "Use blue." });
assert.equal(needsReview(bead({ status: "open", closed_at: null })), false, "an open item never shows");
assert.equal(needsReview(bead({ labels: ["human"] })), false, "needs an item label");
assert.equal(needsReview(bead({ labels: ["question"] })), false, "needs the human label");
assert.equal(needsReview(bead({ metadata: { "board.review": "accepted" } })), false);
assert.equal(needsReview(bead({ metadata: {} })), false);
const concurrent = bead({ comments: [
  { author: "manager:test/manager", text: "Use blue.", created_at: T(20) },
  { author: ME, text: "Use green.", created_at: T(25) },
] });
assert.equal(needsReview(concurrent), false);
assert.equal(managerAnswer(concurrent), null);
const discussion = bead({ comments: [
  { author: "manager:test/manager", text: "Use blue.", created_at: T(20) },
  { author: ME, text: "Why blue?", created_at: T(45) },
  { author: "agent:s1", text: "Noted.", created_at: T(25) },
] });
assert.equal(needsReview(discussion), true);
assert.equal(managerAnswer(discussion).text, "Use blue.");
assert.equal(latestAnswerAuthor(bead({ comments: [{ author: ME, text: "a", created_at: T(30) }] })), ME, "a comment at closed_at counts");
assert.equal(reviewCount([bead(), concurrent, discussion, bead({ status: "open" })]), 2);
// Author parity with agentwatch: only the board user, any link: and any manager: answer.
const withOther = bead({ comments: [
  { author: "manager:test/manager", text: "Use blue.", created_at: T(20) },
  { author: "human:other", text: "Green!", created_at: T(25) },
] });
assert.equal(needsReview(withOther), true, "a comment by another human is not an answer");
const withLink = bead({ comments: [
  { author: "manager:test/manager", text: "Use blue.", created_at: T(20) },
  { author: "link:mac/agent1", text: "Green.", created_at: T(25) },
] });
assert.equal(needsReview(withLink), false, "a later link: answer removes the row");
// An unparsed time keeps the list order.
const unparsed = bead({ comments: [
  { author: "manager:test/manager", text: "Use blue.", created_at: T(20) },
  { author: ME, text: "Green.", created_at: "garbage" },
] });
assert.equal(needsReview(unparsed), false);
// A manager's dismissal with no comment still shows.
const dismissed = bead({ comments: [], close_reason: "Dismissed" });
assert.equal(needsReview(dismissed), true);
assert.equal(needsReview(bead({ comments: [], close_reason: "Responded" })), false);
assert.equal(needsReview(bead({ comments: [], close_reason: "Dismissed", metadata: { "board.review": "pending", "board.review_by": ME } })), false);
console.log("PASS needsReview: closed, pending, latest answer is the manager's; author parity; comment-less dismissal");

{
  // agentwatch age-29t6: an agent's answer with a checked cite of the operator's chat words.
  // The rule of agentwatch's logic.cited_answerer: board.review pending, accepted or reversed,
  // board.review_cite_record a string, board.review_by an agent: (no subagent) or a link: actor.
  const { citedAnswerer, reviewAnswer } = review;
  const H = ME;
  const RECORD = JSON.stringify({ id: "r1", session: "aw-lead", typed_at: 1764082620, sig: "x" });
  const citedBead = ({ by, author, review: state = "pending", record = RECORD, close = "Responded", comments } = {}) => bead({
    close_reason: close,
    metadata: {
      "board.review": state,
      "board.review_by": by,
      "board.review_reason": "The operator gave this answer in the chat of aw-lead at 2026-11-25 14:57 UTC (checked words record r1).",
      "board.review_cite_session": "aw-lead",
      "board.review_cite_typed_at": "2026-11-25T14:57:00Z",
      "board.review_cite_words": "use option two",
      // The daemon writes the answer's time with milliseconds; bd keeps whole seconds,
      // so the agent's comment of the same second (T(20)) counts.
      "board.review_answered_at": "2026-11-02T10:00:20.300Z",
      ...(record === null ? {} : { "board.review_cite_record": record }),
    },
    comments: comments ?? [{ author, text: "Use option two.", created_at: T(20) }],
  });
  const beadWithoutCiteRecord = (over) => citedBead({ ...over, record: null });
  const managerBead = () => bead();
  assert.equal(review.REVIEW_CITE_SESSION_KEY, "board.review_cite_session");
  assert.equal(review.REVIEW_CITE_TYPED_AT_KEY, "board.review_cite_typed_at");
  assert.equal(review.REVIEW_CITE_WORDS_KEY, "board.review_cite_words");
  assert.equal(review.REVIEW_CITE_RECORD_KEY, "board.review_cite_record");

  // citedAnswerer: who claims the cited answer, by the item's review keys only.
  assert.equal(citedAnswerer(citedBead({ by: "agent:s", author: "agent:s" })), "agent:s");
  assert.equal(citedAnswerer(citedBead({ by: "link:taylor/s", author: "link:taylor/s" })), "link:taylor/s");
  for (const state of ["accepted", "reversed"]) assert.equal(citedAnswerer(citedBead({ by: "agent:s", author: "agent:s", review: state })), "agent:s", state);
  for (const state of ["", "other", null, 1]) assert.equal(citedAnswerer(citedBead({ by: "agent:s", author: "agent:s", review: state })), null, String(state));
  const noState = citedBead({ by: "agent:s", author: "agent:s" });
  delete noState.metadata["board.review"];
  assert.equal(citedAnswerer(noState), null, "no board.review");
  for (const by of ["agent:s/doc", "agent:s/", "agent:", "manager:test/manager", ME, "link:Taylor/s", "link:taylor", "link:taylor/", "link:/s", 7, undefined]) {
    assert.equal(citedAnswerer(citedBead({ by, author: "agent:s" })), null, String(by));
  }
  assert.equal(citedAnswerer(beadWithoutCiteRecord({ by: "agent:s", author: "agent:s" })), null, "no record, no cited answer");
  assert.equal(citedAnswerer(citedBead({ by: "agent:s", author: "agent:s", record: { id: "r1" } })), null, "the record must be a string");
  assert.equal(citedAnswerer(bead({ metadata: undefined })), null);

  // needsReview lists a pending cited answer whose latest answer is the cited agent's.
  assert.equal(needsReview(citedBead({ by: "agent:s", author: "agent:s" }), H), true);
  assert.equal(needsReview(citedBead({ by: "agent:s", author: "agent:x" }), H), false, "another agent's comment is no answer");
  assert.equal(needsReview(beadWithoutCiteRecord({ by: "agent:s", author: "agent:s" }), H), false);
  assert.equal(needsReview(citedBead({ by: "link:taylor/s", author: "link:taylor/s" }), H), true);
  assert.equal(needsReview(citedBead({ by: "link:taylor/s", author: "link:taylor/other" }), H), false, "another link agent's later answer is not the cited one");
  assert.equal(needsReview(citedBead({ by: "agent:s/doc", author: "agent:s/doc" }), H), false, "a subagent never cites");
  assert.equal(needsReview(citedBead({ by: "agent:s", author: "agent:s", review: "accepted" }), H), false, "reviewed already");
  assert.equal(needsReview({ ...citedBead({ by: "agent:s", author: "agent:s" }), status: "open", closed_at: null }, H), false, "an open item never shows");
  assert.equal(needsReview(citedBead({ by: "agent:s", author: "agent:s", comments: [
    { author: "agent:s", text: "Use option two.", created_at: T(20) },
    { author: ME, text: "No, option one.", created_at: T(25) },
  ] }), H), false, "the operator's later answer wins");
  assert.equal(needsReview(citedBead({ by: "agent:s", author: "agent:s", comments: [
    { author: "agent:s", text: "Use option two.", created_at: T(20) },
    { author: "agent:s", text: "Done.", created_at: T(45) },
  ] }), H), true, "a comment after the close is discussion");
  // A comment-less cited dismissal shows when board.review_by is the cited agent.
  assert.equal(needsReview(citedBead({ by: "agent:s", comments: [], close: "Dismissed" }), H), true);
  assert.equal(needsReview(beadWithoutCiteRecord({ by: "agent:s", comments: [], close: "Dismissed" }), H), false);
  assert.equal(needsReview(citedBead({ by: "agent:s", comments: [], close: "Responded" }), H), false);
  assert.equal(needsReview(managerBead(), H), true, "unchanged");
  assert.equal(reviewCount([citedBead({ by: "agent:s", author: "agent:s" }), managerBead(), beadWithoutCiteRecord({ by: "agent:s", author: "agent:s" })]), 2);
  // latestAnswer without the cited agent keeps its old authors (lib/answer-outbox.ts holdsAnswer).
  assert.equal(review.latestAnswer(citedBead({ by: "agent:s", author: "agent:s" }), H), null);
  assert.equal(review.latestAnswer(citedBead({ by: "agent:s", author: "agent:s" }), H, "agent:s").author, "agent:s");

  // reviewAnswer: the answer the row shows, with the cite's facts for a cited answer.
  const cited = reviewAnswer(citedBead({ by: "agent:s", author: "agent:s" }), H);
  assert.equal(cited.cite.words, "use option two");
  assert.deepEqual({ ...cited, cite: { ...cited.cite } }, {
    author: "agent:s", text: "Use option two.",
    cite: { session: "aw-lead", typedAt: "2026-11-25T14:57:00Z", words: "use option two" },
  });
  assert.equal(reviewAnswer(citedBead({ by: "link:taylor/s", author: "link:taylor/s" }), H).cite.session, "aw-lead");
  const dismissal = reviewAnswer(citedBead({ by: "agent:s", comments: [], close: "Dismissed" }), H);
  assert.equal(dismissal.text, "", "a comment-less dismissal has no answer text");
  assert.equal(dismissal.cite.words, "use option two");
  const plain = reviewAnswer(managerBead(), H);
  assert.deepEqual({ ...plain }, { author: "manager:test/manager", text: "Use blue." }, "a manager answer has no cite");
  assert.equal(reviewAnswer(bead({ comments: [], close_reason: "Dismissed" }), H), null, "a comment-less manager dismissal stays null");
  assert.equal(reviewAnswer(citedBead({ by: "agent:s", author: "agent:s", comments: [
    { author: "agent:s", text: "Use option two.", created_at: T(20) },
    { author: ME, text: "No.", created_at: T(25) },
  ] }), H), null, "the operator's own answer is no review answer");
  // A later manager answer over stale cite keys is the manager's, with no cite.
  const managerLater = reviewAnswer(citedBead({ by: "agent:s", author: "agent:s", comments: [
    { author: "agent:s", text: "Use option two.", created_at: T(20) },
    { author: "manager:test/manager", text: "Use blue.", created_at: T(25) },
  ] }), H);
  assert.equal(managerLater.author, "manager:test/manager");
  assert.equal(managerLater.cite, undefined);
  // A cite key that is missing or not text shows as empty, never as another value.
  const partial = citedBead({ by: "agent:s", author: "agent:s" });
  delete partial.metadata["board.review_cite_words"];
  partial.metadata["board.review_cite_session"] = 5;
  assert.deepEqual({ ...reviewAnswer(partial, H).cite }, { session: "", typedAt: "2026-11-25T14:57:00Z", words: "" });
  // Review of A3, defect 2: a cited Dismiss on a free-text item writes no comment. An earlier
  // comment of the cited agent (on its own question, say) is never its answer.
  for (const by of ["agent:s", "link:taylor/s"]) {
    const earlier = { author: by, text: "my own note", created_at: T(10) };
    const dismissedEarly = citedBead({ by, comments: [earlier], close: "Dismissed" });
    assert.equal(needsReview(dismissedEarly, H), true, by);
    const shown = reviewAnswer(dismissedEarly, H);
    assert.equal(shown.text, "", `${by}: the earlier comment is no answer`);
    assert.equal(shown.author, by);
    assert.equal(needsReview(citedBead({ by, comments: [earlier] }), H), false, `${by}: a Responded close needs the answer's comment`);
    assert.equal(reviewAnswer(citedBead({ by, comments: [earlier, { author: by, text: "Yes.", created_at: T(20) }] }), H).text, "Yes.");
  }
  // With no answer time that parses, no comment of the cited agent counts.
  for (const at of [undefined, "", "not a time"]) {
    const timeless = citedBead({ by: "agent:s", author: "agent:s" });
    if (at === undefined) delete timeless.metadata["board.review_answered_at"]; else timeless.metadata["board.review_answered_at"] = at;
    assert.equal(needsReview(timeless, H), false, String(at));
  }

  // citeCheckBody: what To Review asks the host; the host's row decides (agentwatch's cite check).
  const body = review.citeCheckBody(citedBead({ by: "agent:s", author: "agent:s" }));
  assert.deepEqual({ ...body, cite: { ...body.cite } }, {
    id: "x-1", close_reason: "Responded", closed_at: T(30), review_by: "agent:s",
    cite: {
      "board.review_cite_session": "aw-lead", "board.review_cite_typed_at": "2026-11-25T14:57:00Z",
      "board.review_cite_words": "use option two", "board.review_cite_record": RECORD,
    },
  });
  assert.equal(review.citeCheckBody(managerBead()), null, "a manager answer is not checked");
  assert.equal(review.citeCheckBody(beadWithoutCiteRecord({ by: "agent:s", author: "agent:s" })), null);
  assert.equal(review.citeCheckBody({ ...citedBead({ by: "agent:s", author: "agent:s" }), closed_at: null }), null);
  const odd = citedBead({ by: "agent:s", author: "agent:s" });
  odd.metadata["board.review_cite_words"] = 5;
  assert.equal("board.review_cite_words" in review.citeCheckBody(odd).cite, false, "only string keys go");

  // Needs You on an item that a cited answer closed: an agent's answer, never "your manager".
  const { validateHumanAnswer } = load("human-validate");
  const verdict = validateHumanAnswer(citedBead({ by: "agent:s", author: "agent:s" }), { action: "respond", text: "No." }, { closedOk: false });
  assert.deepEqual({ ...verdict }, { ok: false, status: 409, error: "An agent answered this; review it in To Review.", code: "agent_answered" });
  console.log("PASS citedAnswerer, needsReview, reviewAnswer and citeCheckBody: an agent's answer with a cite; only comments after the answer (age-29t6)");
}

// A fake store. `fail` maps a step name to a count of calls to fail; `after` makes the step do its
// write (record it) and THEN throw, like a close whose trailing show failed. `getResult` is what get returns.
function fakeStore({ fail = {}, after = [], getResult = null } = {}) {
  const calls = [];
  const step = (name, detail) => async (...args) => {
    const key = name === "meta" && args[1]?.["board.review"] === "reversed" ? "record" : name === "meta" && args[1]?.["board.review"] === null ? "cleanup" : name;
    calls.push(detail ? detail(...args) : name);
    if (fail[key]) throw new Error("boom " + key);
    if (after.includes(key)) throw new Error("late " + key);
    return { id: args[0], status: "x" };
  };
  return {
    calls,
    get: async () => { calls.push("get"); return getResult; },
    reopen: step("reopen"),
    addComment: step("comment", (id, text, actor) => `comment:${text}:${actor}`),
    setMetadata: step("meta", (id, values, actor) => `meta:${JSON.stringify(values)}:${actor}`),
    setStatus: step("close", (id, status, actor, reason) => `close:${status}:${actor}:${reason}`),
  };
}
const now = () => "2026-11-02T12:00:00.000Z";
const go = (s, acked) => reverseAnswer(s, "x-1", "Use green.", "Responded", ME, acked, now);
{
  const s = fakeStore();
  const r = await go(s, true);
  assert.equal(r.warning, undefined);
  assert.deepEqual(s.calls, [
    "reopen",
    "comment:Use green.:human:selden",
    'meta:{"board.acked":null}:human:selden',
    "close:closed:human:selden:Responded",
    'meta:{"board.review":"reversed","board.reviewed_by":"human:selden","board.reviewed_at":"2026-11-02T12:00:00.000Z"}:human:selden',
  ]);
  console.log("PASS reverseAnswer: reopen, comment, unset acked, close, record last");
}
{
  const s = fakeStore();
  await go(s, false);
  assert.ok(!s.calls.some((c) => c.includes("board.acked")), "no board.acked write when not held");
  assert.equal(s.calls.length, 4);
  console.log("PASS reverseAnswer: no board.acked write when the item does not hold it");
}
{
  const s = fakeStore({ fail: { reopen: 1 }, getResult: bead() });
  await assert.rejects(() => go(s, true), (e) => e instanceof ReverseError && e.code === "reverse_not_started" && e.cause?.message === 'boom reopen');
  assert.deepEqual(s.calls, ["reopen", "get"], "no write after a failed reopen");
  console.log("PASS test_a_reverse_that_fails_before_the_reopen_keeps_the_row");
}
{
  // The reopen worked but its trailing show failed: get says the item is open, so go on.
  const s = fakeStore({ after: ["reopen"], getResult: bead({ status: "open", closed_at: null }) });
  const r = await go(s, false);
  assert.equal(r.warning, undefined);
  assert.deepEqual(s.calls.slice(0, 3), ["reopen", "get", "comment:Use green.:human:selden"]);
  console.log("PASS reverseAnswer: a reopen whose read failed continues when the item is open");
}
for (const failAt of ["comment", "close"]) {
  const s = fakeStore({ fail: { [failAt]: 1 }, getResult: bead({ status: "open", closed_at: null }) });
  await assert.rejects(() => go(s, false), (e) => e instanceof ReverseError && e.code === "reverse_incomplete" && e.reviewRemoved === true);
  assert.equal(s.calls.at(-1), 'meta:{"board.review":null,"board.review_by":null,"board.review_reason":null}:human:selden', s.calls.at(-1));
  if (failAt === "comment") assert.ok(!s.calls.some((c) => c.startsWith("close")), "no close after a failed comment");
  console.log(`PASS test_a_reverse_that_fails_after_the_reopen_says_the_question_is_open (${failAt})`);
}
// board.acked: the cleanup unsets it when the item held it and the unset step did not run (or failed).
for (const failAt of ["comment", "meta"]) {
  const s = fakeStore({ fail: { [failAt]: 1 }, getResult: bead({ status: "open", closed_at: null }) });
  await assert.rejects(() => go(s, true), (e) => e.code === "reverse_incomplete" && e.reviewRemoved === true);
  assert.equal(s.calls.at(-1), 'meta:{"board.review":null,"board.review_by":null,"board.review_reason":null,"board.acked":null}:human:selden', failAt + ": " + s.calls.at(-1));
}
{
  // The unset worked, the close failed: acked is already gone, so the cleanup leaves it out.
  const s = fakeStore({ fail: { close: 1 }, getResult: bead({ status: "open", closed_at: null }) });
  await assert.rejects(() => go(s, true), (e) => e.code === "reverse_incomplete");
  assert.ok(!s.calls.at(-1).includes("board.acked"), s.calls.at(-1));
  // Not held: never unset a missing key.
  const t = fakeStore({ fail: { comment: 1 }, getResult: bead({ status: "open", closed_at: null }) });
  await assert.rejects(() => go(t, false), (e) => e.code === "reverse_incomplete");
  assert.ok(!t.calls.some((c) => c.includes("board.acked")));
  console.log("PASS reverseAnswer: the cleanup unsets board.acked only when held and not yet unset");
}
{
  // The close worked and its trailing show failed: the item is closed with the reason, so go on and record.
  const s = fakeStore({ after: ["close"], getResult: bead({ close_reason: "Responded" }) });
  const r = await go(s, false);
  assert.equal(r.warning, undefined);
  assert.ok(s.calls.at(-1).includes('"board.review":"reversed"'));
  assert.ok(!s.calls.some((c) => c.includes('"board.review":null')), "no cleanup of a closed item");
  const w = fakeStore({ after: ["close"], fail: { record: 1 }, getResult: bead({ close_reason: "Responded" }) });
  assert.equal((await go(w, false)).warning, "review_record_failed");
  // Closed with another reason is not ours.
  const o = fakeStore({ fail: { close: 1 }, getResult: bead({ close_reason: "Dismissed" }) });
  await assert.rejects(() => go(o, false), (e) => e.code === "reverse_incomplete");
  console.log("PASS reverseAnswer: a close whose read failed is a success, with the record or the warning");
}
for (const failAt of ["comment", "meta"]) {
  // Someone else closed the item with our reason after our comment or unset failed: not our close.
  const s = fakeStore({ fail: { [failAt]: 1 }, getResult: bead({ close_reason: "Responded" }) });
  await assert.rejects(() => go(s, true), (e) => e instanceof ReverseError && e.code === "reverse_incomplete");
  assert.ok(!s.calls.some((c) => c.includes('"board.review":"reversed"')), "no reversed record");
  assert.ok(!s.calls.some((c) => c.startsWith("close")), "no close after the failed step");
  console.log(`PASS reverseAnswer: another writer's same-reason close after a failed ${failAt} is not success`);
}
{
  const s = fakeStore({ fail: { meta: 1, cleanup: 1 }, getResult: bead({ status: "open", closed_at: null }) });
  await assert.rejects(() => go(s, true), (e) => e.code === "reverse_incomplete" && e.reviewRemoved === false);
  console.log("PASS reverseAnswer: reviewRemoved false when the cleanup fails too");
}
{
  const s = fakeStore({ fail: { record: 1 } });
  const r = await go(s, false);
  assert.equal(r.warning, "review_record_failed");
  console.log("PASS reverseAnswer: a failed final record is a warning, the answer stands");
}
{
  // A server log line names the error by its name and code only: bd's message can hold its
  // argv, and `bd comment ID TEXT` puts the operator's answer text there (M5).
  const { errorTag } = review;
  const execFailure = Object.assign(new Error("Command failed: bd comment x-1 SECRET ANSWER TEXT"), { code: 1 });
  assert.equal(errorTag(execFailure), "Error (1)");
  class BdError extends Error { constructor(m, c) { super(m); this.name = "BdError"; this.code = c; } }
  assert.equal(errorTag(new BdError("bd: SECRET ANSWER TEXT", "not_found")), "BdError (not_found)");
  assert.equal(errorTag(new BdError("SECRET ANSWER TEXT")), "BdError");
  assert.equal(errorTag(new BdError("x", "SECRET ANSWER TEXT")), "BdError", "a code that is not a plain token is left out");
  assert.equal(errorTag("SECRET ANSWER TEXT"), "a non-Error value");
  assert.equal(errorTag(undefined), "a non-Error value");
  // The routes' rules and their log lines live in lib/human-answer.ts and
  // lib/review-answer.ts (age-6mk); the routes log nothing themselves.
  for (const [route, lib] of [["human", "human-answer"], ["review", "review-answer"]]) {
    const routeSrc = readFileSync(new URL(`../app/api/p/[projectId]/beads/[id]/${route}/route.ts`, import.meta.url), "utf8");
    assert.ok(!routeSrc.includes("console."), `the ${route} route logs nothing itself`);
    const src = readFileSync(new URL(`../lib/${lib}.ts`, import.meta.url), "utf8");
    const logs = src.split("\n").filter((line) => /\blog\(`/.test(line));
    assert.ok(logs.length > 0, route);
    for (const line of logs) assert.match(line, /log\(`[^`]*\$\{errorTag\([^)]*\)\}`\);/, `${route}: ${line.trim()}`);
    // The default sink passes the line on as it is.
    assert.ok(src.includes("((line: string) => console.error(line))"), `${route}: the default log is console.error`);
  }
  console.log("PASS errorTag: a log line holds the error's name and code, never its message");
}
{
  // M3: an answer from Needs You on an item that the manager already answered and closed
  // (its review pending) says where the answer is, instead of "The choices changed".
  const { validateHumanAnswer } = load("human-validate");
  const { renderChoice } = load("human-choices");
  const green = { version: 1, id: "green", label: "Use green", description: "Make a new theme.", recommended: false };
  const blue = { version: 1, id: "blue", label: "Use blue", description: "Keep blue.", recommended: true };
  const meta = { "scotty.choices": { version: 1, options: [green, blue] }, "board.review": "pending", "board.review_by": "manager:test/manager" };
  const answered = bead({ metadata: meta });
  const MESSAGE = "Your manager answered this; review it in To Review.";
  for (const body of [
    { action: "respond", choice: green, text: renderChoice(green) },
    { action: "dismiss", choice: blue, text: renderChoice(blue) },
    { action: "respond", text: "Use green." },
    { action: "decline", text: "The premise is wrong." },
    { action: "dismiss" },
  ]) {
    const verdict = validateHumanAnswer(answered, body, { closedOk: false });
    assert.deepEqual({ ...verdict }, { ok: false, status: 409, error: MESSAGE, code: "manager_answered" }, JSON.stringify(body));
  }
  // A Reverse (closedOk) still passes, and an item without a pending review keeps the old answers.
  assert.equal(validateHumanAnswer(answered, { action: "respond", choice: green, text: renderChoice(green) }, { closedOk: true }).ok, true);
  const accepted = bead({ metadata: { ...meta, "board.review": "accepted" } });
  assert.equal(validateHumanAnswer(accepted, { action: "respond", choice: green, text: renderChoice(green) }, { closedOk: false }).code, "stale_choice");
  const open = bead({ status: "open", closed_at: null, metadata: meta });
  assert.equal(validateHumanAnswer(open, { action: "respond", choice: green, text: renderChoice(green) }, { closedOk: false }).ok, true, "an open item with a stale pending is answerable");
  console.log("PASS validateHumanAnswer: an item the manager answered and closed points to To Review");
}
