// Only an explicitly configured disposable bd board and isolated Scotty server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { renderChoice, renderDecline } from "../lib/human-choices.ts";
const base = process.env.SCOTTY_TEST_URL;
const repo = process.env.SCOTTY_CHOICES_REPO;
const project = process.env.SCOTTY_TEST_PROJECT || "choices";
assert.ok(base && repo, "Set SCOTTY_TEST_URL and SCOTTY_CHOICES_REPO to disposable fixtures");
const MANAGER = "manager:test/manager";
const bin = process.env.SCOTTY_TEST_BD || "bd";
const run = (actor, args) => execFileSync(bin, args, { cwd: repo, encoding: "utf8", env: { ...process.env, BEADS_ACTOR: actor } });
const bd = (...args) => JSON.parse(run(MANAGER, args));
const blue = { id: "blue", label: "Use blue", description: "Use the existing blue theme.", recommended: true };
const green = { id: "green", label: "Use green", description: "Use a new green theme.", recommended: false };
const definition = { version: 1, options: [green, blue] };
const choice = (o) => ({ version: 1, ...o });

// An item as the manager leaves it: the review record, the answer comment, the close.
function managerAnswered({ acked = true } = {}) {
  const meta = { "scotty.choices": definition, "scotty.rank": 1024, ...(acked ? { "board.acked": "agent:s1" } : {}) };
  const id = bd("create", "Which theme?", "--type", "task", "--labels", "human,question", "--metadata", JSON.stringify(meta), "--json").id;
  run(MANAGER, ["update", id, "--set-metadata", "board.review=pending", "--set-metadata", `board.review_by=${MANAGER}`, "--set-metadata", "board.review_reason=Blue is the default."]);
  run(MANAGER, ["comment", id, renderChoice(choice(blue))]);
  run(MANAGER, ["close", id, "--reason", "Responded"]);
  return id;
}
const show = (id) => bd("show", id, "--json")[0];
const comments = (id) => bd("comments", id, "--json");
const postTo = (path, body) => fetch(`${base}/api/p/${project}/beads/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(base).origin, connection: "close" }, body: JSON.stringify(body) });
const review = (id, body) => postTo(`${id}/review`, body);
const reverse = (id, answer) => review(id, { action: "reverse", answer, actor: "agent:fake" });

// Accept.
const a = managerAnswered();
await new Promise((r) => setTimeout(r, 1500)); // bd stamps whole seconds
run("human:selden", ["comment", a, "Why blue?"]); // discussion after the close never clears the row
const accepted = await review(a, { action: "accept", actor: "agent:fake" });
assert.equal(accepted.status, 200, await accepted.text());
let bead = show(a);
assert.equal(bead.metadata["board.review"], "accepted");
assert.equal(bead.metadata["board.reviewed_by"], "human:selden");
assert.match(bead.metadata["board.reviewed_at"], /^\d{4}-\d\d-\d\dT.*Z$/);
assert.equal(bead.status, "closed");
const again = await review(a, { action: "accept" });
assert.equal(again.status, 409);
assert.equal((await again.json()).code, "not_pending");
console.log("PASS review API: accept records who and when; a second accept is 409 not_pending");

// Reverse with another option.
const b = managerAnswered();
const before = comments(b).length;
const reversed = await reverse(b, { action: "respond", choice: choice(green), text: renderChoice(choice(green)) });
assert.equal(reversed.status, 200, await reversed.text());
bead = show(b);
assert.equal(bead.status, "closed");
assert.equal(bead.close_reason, "Responded");
const last = comments(b).at(-1);
assert.equal(last.text, renderChoice(choice(green)));
assert.equal(last.author, "human:selden");
assert.equal(comments(b).length, before + 1);
assert.equal(bead.metadata["board.acked"], undefined, "board.acked is gone");
assert.equal(bead.metadata["board.review"], "reversed");
assert.equal(bead.metadata["board.reviewed_by"], "human:selden");
assert.equal(bead.metadata["scotty.rank"], 1024);
assert.equal((await review(b, { action: "accept" })).status, 409, "a reversed item is not pending");
console.log("PASS review API: reverse reopens, comments as the operator, clears acked, closes Responded, records reversed");

// Reverse with a decline.
const c = managerAnswered();
const declined = await reverse(c, { action: "decline", text: "The premise is wrong." });
assert.equal(declined.status, 200, await declined.text());
assert.equal(show(c).close_reason, "Declined");
assert.equal(comments(c).at(-1).text, renderDecline("The premise is wrong."));
assert.equal(show(c).metadata["board.review"], "reversed");
console.log("PASS review API: reverse with a decline closes Declined");

// Reverse with a dismiss (the recommended option).
const c2 = managerAnswered();
assert.equal((await reverse(c2, { action: "dismiss", choice: choice(green), text: renderChoice(choice(green)) })).status, 409, "dismiss needs the recommended option");
assert.equal(comments(c2).length, 1);
assert.equal((await reverse(c2, { action: "dismiss", choice: choice(blue), text: renderChoice(choice(blue)) })).status, 200);
assert.equal(show(c2).close_reason, "Dismissed");
assert.equal(comments(c2).at(-1).author, "human:selden");
assert.equal((await reverse(managerAnswered(), { action: "dismiss" })).status, 400, "a dismiss with no snapshot has no answer to write");
console.log("PASS review API: reverse with a dismiss writes the recommended snapshot");

// The asker had not read the manager's answer: no board.acked.
const d = managerAnswered({ acked: false });
const unread = await reverse(d, { action: "respond", text: "Use green, please." });
assert.equal(unread.status, 200, await unread.text());
bead = show(d);
assert.equal(bead.metadata["board.review"], "reversed");
assert.equal(comments(d).at(-1).text, "Use green, please.");
console.log("PASS review API: reverse on an item that never held board.acked");

// Stale choice and forged text write nothing.
const e = managerAnswered();
const stale = await reverse(e, { action: "respond", choice: { ...choice(green), label: "Changed" }, text: renderChoice(choice(green)) });
assert.equal(stale.status, 409);
assert.equal((await reverse(e, { action: "respond", choice: choice(green), text: "Forged" })).status, 400);
assert.equal(comments(e).length, 1, "no new comment");
assert.equal(show(e).metadata["board.review"], "pending");
assert.equal(show(e).status, "closed");
console.log("PASS review API: a stale or forged reverse writes nothing");

// A concurrent operator answer that is the latest answer excludes the row.
const f = managerAnswered();
run("human:selden", ["reopen", f]);
run("human:selden", ["comment", f, "Use green."]);
run("human:selden", ["close", f, "--reason", "Responded"]);
assert.equal((await review(f, { action: "accept" })).status, 409);
// An open item never shows.
const g = bd("create", "Open one", "--type", "task", "--labels", "human,question", "--json").id;
assert.equal((await review(g, { action: "accept" })).status, 409);
assert.equal((await review("no-such-id", { action: "accept" })).status, 409);
console.log("PASS review API: a later operator answer, an open item and an unknown item are 409");

// An answer from Needs You on an open item that still holds the review keys removes them.
const h = bd("create", "Half-reversed", "--type", "task", "--labels", "human,question", "--metadata", JSON.stringify({ "board.review": "pending", "board.review_by": MANAGER, "board.review_reason": "r", "scotty.rank": 2048 }), "--json").id;
const answered = await postTo(`${h}/human`, { action: "respond", text: "Use green." });
assert.equal(answered.status, 200, await answered.text());
bead = show(h);
assert.equal(bead.status, "closed");
for (const key of ["board.review", "board.review_by", "board.review_reason"]) assert.equal(bead.metadata[key], undefined, key);
assert.equal(bead.metadata["scotty.rank"], 2048);
console.log("PASS review API: a Needs You answer removes the review keys");

// Probe: does a percent-encoded path segment reach the review route?
const p = managerAnswered();
const probe = await postTo(`${p}/%72eview`, { action: "accept" });
console.log(`PROBE %72eview: status ${probe.status}; review is now ${show(p).metadata["board.review"]}`);
