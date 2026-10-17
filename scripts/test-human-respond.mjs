// Respond / Dismiss on a `human` bead close it like `bd human` (Responded / Dismissed),
// keep the `human` label for the record, and unblock the work bead that waited on it.
// SCOTTY_HUMAN_RESPOND=keep-open restores the old behaviour (see the last check, which
// only runs when the server was started with it). Isolated demo server only.
import assert from "node:assert/strict";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");
const json = { "Content-Type": "application/json" };
const keepOpen = process.env.SCOTTY_HUMAN_RESPOND_EXPECT === "keep-open";

const projects = (await (await fetch(`${base}/api/projects`)).json()).projects;
const project = projects.find((p) => p.demo) ?? projects[0];
assert.ok(project, "a demo project exists");
const api = `${base}/api/p/${project.id}`;
const post = (path, body) => fetch(`${api}${path}`, { method: "POST", headers: json, body: JSON.stringify(body) });
const get = async (id) => {
  const list = (await (await fetch(`${api}/beads`)).json()).beads;
  return list.find((b) => b.id === id);
};
const actor = (await (await fetch(`${base}/api/config`)).json()).humanActor;

async function question(title) {
  const work = (await (await post("/beads", { title: `Work waiting on ${title}`, issue_type: "task" })).json());
  const q = (await (await post("/beads", { title, issue_type: "task", labels: ["human"] })).json());
  const workId = (work.bead ?? work).id, qId = (q.bead ?? q).id;
  assert.equal((await post(`/beads/${workId}/deps`, { depends_on_id: qId, type: "blocks" })).status, 200);
  return { workId, qId };
}
const blockedBy = (work, qId) =>
  (work.dependencies ?? []).some((d) => d.depends_on_id === qId && d.type === "blocks");

for (const action of ["respond", "dismiss"]) {
  const { workId, qId } = await question(`Question to ${action}`);
  const r = await post(`/beads/${qId}/human`, action === "respond" ? { action, text: "Use the blue one." } : { action });
  assert.equal(r.status, 200, await r.text());
  const q = await get(qId);
  if (keepOpen) {
    assert.equal(q.status, "open", "keep-open leaves the bead open");
    assert.ok(!q.labels.includes("human"), "keep-open clears the human label");
    continue;
  }
  assert.ok(q.labels.includes("human"), "the human label stays for the record");
  assert.equal(q.status, "closed", `${action} closes the bead`);
  assert.equal(q.close_reason, action === "respond" ? "Responded" : "Dismissed");
  if (action === "respond") {
    const c = q.comments.at(-1);
    assert.equal(c.text, "Use the blue one.");
    assert.equal(c.author, actor, "the comment carries the human actor");
  }
  const work = await get(workId);
  assert.ok(blockedBy(work, qId), "the dependency edge remains");
  assert.equal(q.status, "closed", "so the work bead's only blocker is closed and it is ready");
}
console.log(`PASS human respond: ${keepOpen ? "keep-open keeps the old behaviour" : "Respond/Dismiss close with Responded/Dismissed, keep the label, unblock the work bead"}`);
