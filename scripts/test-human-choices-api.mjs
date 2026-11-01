// Only an explicitly configured disposable bd board and isolated Scotty server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { renderChoice, renderSelection } from "../lib/human-choices.ts";
const base = process.env.SCOTTY_TEST_URL;
const repo = process.env.SCOTTY_CHOICES_REPO;
assert.ok(base && repo, "Set SCOTTY_TEST_URL and SCOTTY_CHOICES_REPO to disposable fixtures");
const blue = { id: "blue", label: "Use blue", description: "Use the existing blue theme.", recommended: true };
const green = { id: "green", label: "Use green", description: "Use a new green theme.", recommended: false };
const definition = { version: 1, options: [green, blue] };
const bd = (...args) => JSON.parse(execFileSync(process.env.SCOTTY_TEST_BD || "bd", args, { cwd: repo, encoding: "utf8" }));
function create(choices = definition) {
  const q = bd("create", "Which theme?", "--type", "task", "--labels", "human,question", "--description", "Choose a theme. I recommend blue.", "--metadata", JSON.stringify({ "scotty.choices": choices, "scotty.rank": 1024 }), "--json");
  return (q.data || q).id;
}
const get = async (id) => (await (await fetch(`${base}/api/p/choices/beads/${id}`)).json());
const post = (id, body) => fetch(`${base}/api/p/choices/beads/${id}/human`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(base).origin }, body: JSON.stringify(body) });
for (const action of ["respond", "dismiss"]) {
  const id = create();
  const choice = { version: 1, ...(action === "respond" ? green : blue) };
  const before = bd("comments", id, "--json");
  const response = await post(id, { action, choice: { ...choice, label: "Changed label" }, text: renderChoice(choice) });
  assert.equal(response.status, 409, await response.text());
  assert.equal(bd("comments", id, "--json").length, before.length, "stale selection writes no comment");
  const invalid = await post(id, { action, choice, text: "Forged comment" });
  assert.equal(invalid.status, 400);
  if (action === "dismiss") {
    const wrong = { version: 1, ...green };
    assert.equal((await post(id, { action, choice: wrong, text: renderChoice(wrong) })).status, 409);
  }
  const good = await post(id, { action, choice, text: renderChoice(choice), actor: "agent:fake" });
  assert.equal(good.status, 200, await good.text());
  const bead = await get(id);
  assert.equal(bead.status, "closed");
  assert.equal(bead.close_reason, action === "respond" ? "Responded" : "Dismissed");
  assert.equal(bd("comments", id, "--json").at(-1).text, renderChoice(choice));
  assert.equal(bd("comments", id, "--json").at(-1).author, "human:selden");
  assert.deepEqual(bead.metadata["scotty.choices"], definition);
  assert.equal(bead.metadata["scotty.rank"], 1024);
  assert.ok(bead.labels.includes("human"));
  assert.equal((await post(id, { action, choice, text: renderChoice(choice) })).status, 409, "closed question cannot be answered twice");
}
const free = create();
assert.equal((await post(free, { action: "respond", text: "Use another theme." })).status, 200);
assert.equal(bd("comments", free, "--json").at(-1).text, "Use another theme.");
const legacy = create();
assert.equal((await post(legacy, { action: "dismiss" })).status, 200);
assert.equal((await get(legacy)).close_reason, "Dismissed");
console.log("PASS human choices API: stale snapshots, canonical text, actor, Respond, Dismiss, legacy");

const multi = create({ ...definition, multiSelect: true });
const selected = [{ version: 1, ...blue }, { version: 1, ...green }];
assert.equal((await post(multi, { action: "respond", choices: [selected[0], selected[0]], text: renderSelection([selected[0], selected[0]]) })).status, 409);
assert.equal((await post(multi, { action: "respond", choices: selected, text: renderSelection(selected) })).status, 200);
assert.equal(bd("comments", multi, "--json").at(-1).text, renderSelection(selected));
console.log("PASS multiple choices API: multiple selections and duplicate rejection");
