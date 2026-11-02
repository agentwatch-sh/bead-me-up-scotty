// Pure contract tests for lib/review.ts; no server or board data required.
import assert from "node:assert/strict";
import { needsReview, reviewCount, managerAnswer, latestAnswerAuthor, reverseAnswer, ReverseError } from "../lib/review.ts";

const T = (s) => `2026-11-02T10:00:${String(s).padStart(2, "0")}Z`;
const bead = (over = {}) => ({
  id: "x-1", title: "Q", status: "closed", closed_at: T(30), labels: ["human", "question"],
  metadata: { "board.review": "pending", "board.review_by": "manager:test/manager" },
  comments: [{ author: "manager:test/manager", text: "Use blue.", created_at: T(20) }],
  ...over,
});

assert.equal(needsReview(bead()), true);
assert.equal(latestAnswerAuthor(bead()), "manager:test/manager");
assert.deepEqual(managerAnswer(bead()), { author: "manager:test/manager", text: "Use blue." });
assert.equal(needsReview(bead({ status: "open", closed_at: null })), false, "an open item never shows");
assert.equal(needsReview(bead({ labels: ["human"] })), false, "needs an item label");
assert.equal(needsReview(bead({ labels: ["question"] })), false, "needs the human label");
assert.equal(needsReview(bead({ metadata: { "board.review": "accepted" } })), false);
assert.equal(needsReview(bead({ metadata: {} })), false);
// An operator answer after the manager's (an answer from Needs You after a failed Reverse).
const concurrent = bead({ comments: [
  { author: "manager:test/manager", text: "Use blue.", created_at: T(20) },
  { author: "human:selden", text: "Use green.", created_at: T(25) },
] });
assert.equal(needsReview(concurrent), false);
assert.equal(managerAnswer(concurrent), null);
// A discussion comment after closed_at never clears the row.
const discussion = bead({ comments: [
  { author: "manager:test/manager", text: "Use blue.", created_at: T(20) },
  { author: "human:selden", text: "Why blue?", created_at: T(45) },
  { author: "agent:s1", text: "Noted.", created_at: T(25) },
] });
assert.equal(needsReview(discussion), true);
assert.equal(managerAnswer(discussion).text, "Use blue.");
// A comment exactly at closed_at counts.
assert.equal(latestAnswerAuthor(bead({ comments: [{ author: "human:selden", text: "a", created_at: T(30) }] })), "human:selden");
// No answer comment: fall back to review_by.
assert.equal(needsReview(bead({ comments: [] })), true);
assert.equal(needsReview(bead({ comments: [], metadata: { "board.review": "pending", "board.review_by": "human:selden" } })), false);
assert.equal(reviewCount([bead(), concurrent, discussion, bead({ status: "open" })]), 2);
console.log("PASS needsReview: closed, pending, latest answer is the manager's");

function fakeStore(failAt = null) {
  const calls = [];
  const step = (name, detail) => async (...args) => {
    calls.push(detail ? detail(...args) : name);
    if (failAt === name || (failAt === "last" && name === "meta" && calls.filter((c) => c.startsWith("meta")).length > 0 && args[1]?.["board.review"] === "reversed")) throw new Error("boom " + name);
    return { id: args[0], status: "x" };
  };
  return {
    calls,
    reopen: step("reopen"),
    addComment: step("comment", (id, text, actor) => `comment:${text}:${actor}`),
    setMetadata: step("meta", (id, values, actor) => `meta:${JSON.stringify(values)}:${actor}`),
    setStatus: step("close", (id, status, actor, reason) => `close:${status}:${actor}:${reason}`),
  };
}
const now = () => "2026-11-02T12:00:00.000Z";
{
  const s = fakeStore();
  const r = await reverseAnswer(s, "x-1", "Use green.", "Responded", "human:selden", true, now);
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
  await reverseAnswer(s, "x-1", "Use green.", "Responded", "human:selden", false, now);
  assert.ok(!s.calls.some((c) => c.includes("board.acked")), "no board.acked write when not held");
  assert.equal(s.calls.length, 4);
  console.log("PASS reverseAnswer: no board.acked write when the item does not hold it");
}
{
  const s = fakeStore("reopen");
  await assert.rejects(() => reverseAnswer(s, "x-1", "c", "Responded", "human:selden", true, now), (e) => e instanceof ReverseError && e.code === "reverse_not_started");
  assert.deepEqual(s.calls, ["reopen"], "no other call after a failed reopen");
  console.log("PASS test_a_reverse_that_fails_before_the_reopen_keeps_the_row");
}
for (const failAt of ["comment", "close"]) {
  const s = fakeStore(failAt);
  await assert.rejects(() => reverseAnswer(s, "x-1", "c", "Responded", "human:selden", false, now), (e) => e instanceof ReverseError && e.code === "reverse_incomplete" && e.reviewRemoved === true);
  assert.ok(s.calls.at(-1).startsWith('meta:{"board.review":null,"board.review_by":null,"board.review_reason":null}'), "the review keys go: " + s.calls.at(-1));
  if (failAt === "comment") assert.ok(!s.calls.some((c) => c.startsWith("close")), "no close after a failed comment");
  console.log(`PASS test_a_reverse_that_fails_after_the_reopen_says_the_question_is_open (${failAt})`);
}
{
  const s = fakeStore("meta");
  await assert.rejects(() => reverseAnswer(s, "x-1", "c", "Responded", "human:selden", true, now), (e) => e instanceof ReverseError && e.code === "reverse_incomplete" && e.reviewRemoved === false);
  console.log("PASS reverseAnswer: a failed acked unset is incomplete; reviewRemoved false when removal fails too");
}
{
  const s = fakeStore("last");
  const r = await reverseAnswer(s, "x-1", "c", "Responded", "human:selden", false, now);
  assert.equal(r.warning, "review_record_failed");
  console.log("PASS reverseAnswer: a failed final record is a warning, the answer stands");
}
