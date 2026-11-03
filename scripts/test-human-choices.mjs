// Pure contract tests; no server or real board data required.
import assert from "node:assert/strict";
import { parseChoices, parseChoice, renderChoice } from "../lib/human-choices.ts";
const blue = { id: "blue", label: "Use blue", description: "Use the existing blue theme.", recommended: true };
const green = { id: "green", label: "Use green", description: "Use a new green theme.", recommended: false };
const definition = { version: 1, options: [green, blue] };
assert.deepEqual(parseChoices(definition), [blue, green]);
assert.deepEqual(parseChoices(JSON.stringify(definition)), [blue, green]);
for (const bad of [null, "{", { ...definition, version: 2 }, { ...definition, options: [blue] }, { ...definition, options: [blue, blue] }, { ...definition, options: [green, green] }, { ...definition, options: [{ ...blue, id: "bad/id" }, green] }, { ...definition, options: [{ ...blue, label: " " }, green] }, { ...definition, options: [{ ...blue, description: "x".repeat(241) }, green] }, { ...definition, options: [{ ...blue, recommended: 1 }, green] }, { ...definition, extra: "x".repeat(9000) }]) {
  assert.equal(parseChoices(bad), null, JSON.stringify(bad));
}
const snapshot = { version: 1, ...blue };
const text = 'Selected: Use blue\nUse the existing blue theme.\n\n```board-choice\n{"version":1,"id":"blue","label":"Use blue","description":"Use the existing blue theme.","recommended":true}\n```';
assert.equal(renderChoice(snapshot), text);
assert.deepEqual(parseChoice(text), snapshot);
assert.equal(parseChoice(text + " altered"), null);
const unicode = { ...snapshot, label: 'Café "blue" 😀', description: "First line\nSecond line \\" };
assert.deepEqual(parseChoice(renderChoice(unicode)), unicode);
console.log("PASS human choices: validation, ordering, canonical snapshots, unicode");

// Multi-select retains the same option schema and one recommendation.
assert.deepEqual(parseChoices({ ...definition, multiSelect: true }), [blue, green]);
assert.equal(parseChoices({ ...definition, multiSelect: "true" }), null);
const { renderSelection, parseSelection } = await import("../lib/human-choices.ts");
const selected = [{ version: 1, ...green }, { version: 1, ...blue }];
assert.deepEqual(parseSelection(renderSelection(selected)), selected);
assert.equal(parseSelection(renderSelection([selected[0], selected[0]])), null);

const { readFileSync } = await import("node:fs");
for (const fixture of JSON.parse(readFileSync(new URL("./choice-snapshots.json", import.meta.url), "utf8"))) {
  const rendered = fixture.choices.length === 1 ? renderChoice(fixture.choices[0], fixture.note) : renderSelection(fixture.choices, fixture.note);
  assert.equal(rendered, fixture.text, "shared Python/TypeScript canonical comment fixture");
}

const { renderDecline, parseDecline } = await import("../lib/human-choices.ts");
assert.equal(parseDecline(renderDecline("The premise is wrong.")), "The premise is wrong.");
assert.equal(parseDecline("The premise is wrong."), null);

// The operator's comment rides with the choice (agentwatch, 2026-11-03): one comment keeps both.
{
  const { parseNote } = await import("../lib/human-choices.ts");
  const note = "Also check the footer.\nIt looks wrong.";
  const noted = 'Selected: Use blue\nUse the existing blue theme.\n\nThe person also wrote: Also check the footer.\nIt looks wrong.\n\n```board-choice\n{"version":1,"id":"blue","label":"Use blue","description":"Use the existing blue theme.","recommended":true,"note":"Also check the footer.\\nIt looks wrong."}\n```';
  assert.equal(renderChoice(snapshot, note), noted);
  assert.deepEqual(parseChoice(noted), snapshot);
  assert.equal(parseNote(noted), note);
  assert.equal(parseNote(text), null);
  assert.equal(parseNote("Use blue"), null);
  assert.equal(parseChoice(noted.replace("wrote: Also", "wrote: Not")), null, "the visible note and the fenced note agree");
  for (const bad of ["", " ", null, 5, "x".repeat(4001)]) {
    assert.throws(() => renderChoice(snapshot, bad), JSON.stringify(bad));
    const fenced = JSON.stringify({ ...snapshot, note: bad });
    assert.equal(parseChoice(`Selected: Use blue\nUse the existing blue theme.\n\nThe person also wrote: ${bad}\n\n\`\`\`board-choice\n${fenced}\n\`\`\``), null);
  }
  const both = renderSelection(selected, "Both, please.");
  assert.ok(both.endsWith(`\n\nThe person also wrote: Both, please.\n\n\`\`\`board-choices\n${JSON.stringify({ version: 1, choices: selected, note: "Both, please." })}\n\`\`\``));
  assert.deepEqual(parseSelection(both), selected);
  assert.equal(parseNote(both), "Both, please.");
  const noteFixtures = JSON.parse(readFileSync(new URL("./choice-snapshots.json", import.meta.url), "utf8")).filter((f) => "note" in f);
  assert.equal(noteFixtures.length, 2);
  for (const fixture of noteFixtures) {
    const rendered = fixture.choices.length === 1 ? renderChoice(fixture.choices[0], fixture.note) : renderSelection(fixture.choices, fixture.note);
    assert.equal(rendered, fixture.text, "shared Python/TypeScript comment with a note");
    assert.equal(parseNote(fixture.text), fixture.note);
  }
  console.log("PASS human choices: a note rides with a choice or a selection");
}
