// Pure contract tests: the operator's comment reaches the agent with every answer (agentwatch, 2026-11-03).
// No server or board data required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
// lib/human-validate.ts imports extensionless siblings, which node cannot resolve: transpile like test-review.mjs.
const require = createRequire(import.meta.url);
function load(name) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: (id) => id.startsWith("./") ? load(id.slice(2)) : require(id), Error, Object, Date, Array, TextEncoder }, { filename: name });
  return exports;
}
const { validateHumanAnswer, humanBodySchema } = load("human-validate");
const { renderChoice, renderSelection, renderGroup } = load("human-choices");

const blue = { version: 1, id: "blue", label: "Use blue", description: "Keep blue.", recommended: true };
const green = { version: 1, id: "green", label: "Use green", description: "Make a new theme.", recommended: false };
const options = [green, blue].map(({ version, ...o }) => o);
const item = (choices) => ({ id: "q-1", title: "Q", status: "open", labels: ["human", "question"], metadata: choices === undefined ? {} : { "scotty.choices": choices } });
const single = item({ version: 1, options });
const multi = item({ version: 1, options, multiSelect: true });
const legacy = item();
const note = "Approve, but keep the old flag.";
// The route parses the body first; a key the schema does not know never reaches the check.
const check = (bead, body) => validateHumanAnswer(bead, humanBodySchema.parse(body), { closedOk: false });

// A tapped option and the typed comment: one comment holds both.
for (const [action, choice, reason] of [["respond", green, "Responded"], ["dismiss", blue, "Dismissed"]]) {
  const text = renderChoice(choice, note);
  assert.deepEqual({ ...check(single, { action, choice, note, text }) }, { ok: true, comment: text, reason }, action);
  assert.equal(check(single, { action, choice, note: "Other words.", text }).code, "invalid_choice_text", "the note binds the comment");
  assert.equal(check(single, { action, choice, text }).code, "invalid_choice_text", "a note in the text needs the note in the body");
  assert.equal(check(single, { action, choice, note, text: renderChoice(choice) }).code, "invalid_choice_text");
  for (const bad of ["", " ", "x".repeat(4001)]) {
    assert.equal(check(single, { action, choice, note: bad, text }).code, "invalid_note", JSON.stringify(bad));
  }
}
// Respond with selections and a comment.
{
  const selected = [blue, green];
  const text = renderSelection(selected, note);
  assert.deepEqual({ ...check(multi, { action: "respond", choices: selected, note, text }) }, { ok: true, comment: text, reason: "Responded" });
  assert.equal(check(multi, { action: "respond", choices: selected, note: "Other.", text }).code, "invalid_choice_text");
}
// Dismiss of an item with no choices: the comment is kept as it is.
assert.deepEqual({ ...check(legacy, { action: "dismiss", text: "Fine, but log it." }) }, { ok: true, comment: "Fine, but log it.", reason: "Dismissed" });
assert.deepEqual({ ...check(legacy, { action: "dismiss" }) }, { ok: true, comment: null, reason: "Dismissed" }, "a bare Dismiss writes no comment");
assert.equal(check(legacy, { action: "dismiss", text: "  " }).code, "invalid_note", "a blank comment is no comment to keep");
assert.equal(check(legacy, { action: "dismiss", note, text: "Fine." }).code, "invalid_note", "a note goes with a choice");
assert.equal(check({ ...legacy, status: "closed" }, { action: "dismiss", text: "Fine, but log it." }).code, "stale_question", "a closed item gets no late comment");
// Decline: the typed text is the reason.
assert.deepEqual({ ...check(single, { action: "decline", text: "The premise is wrong." }) }, { ok: true, comment: "The person declined this question: The premise is wrong.\n\n```board-decline\n{\"version\":1,\"text\":\"The premise is wrong.\"}\n```", reason: "Declined" });
// A grouped answer keeps each question's note.
{
  const question = { id: "q1", question: "Which theme?", header: "Theme", multiSelect: false, options };
  const group = item({ version: 2, questions: [question] });
  const answers = [{ id: "q1", question: "Which theme?", header: "Theme", multiSelect: false, action: "responded", choices: [blue], text: null, note }];
  for (const action of ["respond", "dismiss"]) {
    assert.deepEqual({ ...check(group, { action, answers, text: renderGroup(answers) }) }, { ok: true, comment: renderGroup(answers), reason: action === "dismiss" ? "Dismissed" : "Responded" }, action);
  }
}
console.log("PASS human note: a choice, a selection, Dismiss and a group keep the operator's comment");
