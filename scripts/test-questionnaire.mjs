import assert from "node:assert/strict";
import { parseQuestions, renderGroup, parseGroup } from "../lib/human-choices.ts";
const options = [{id:"a",label:"A",description:"First option",recommended:true},{id:"b",label:"B",description:"Second option",recommended:false}];
const q = {id:"q1",question:"Which theme?",header:"Theme",multiSelect:false,options};
assert.equal(parseQuestions({version:2,questions:[q,{...q,id:"q2"}]}).length,2);
assert.equal(parseQuestions({version:2,questions:[q,q]}),null);
assert.equal(parseQuestions({version:2,questions:[]}),null);
const answers=[{id:q.id,question:q.question,header:q.header,multiSelect:false,action:"responded",choices:[{version:1,...options[0]}],text:null},{id:"q2",question:"Which format?",header:"Format",multiSelect:false,action:"declined",choices:null,text:"The premise is wrong."}];
assert.deepEqual(parseGroup(renderGroup(answers)),answers);
assert.equal(parseGroup(renderGroup([answers[0],answers[0]])),null);
console.log("PASS questionnaire: definitions and canonical grouped answers");
const {readFileSync}=await import("node:fs");
const fixture=JSON.parse(readFileSync(new URL("./questionnaire-snapshot.json",import.meta.url),"utf8"));
assert.equal(renderGroup(fixture.answers),fixture.text,"shared Python/TypeScript group comment");

// A question keeps the note typed with its choice (agentwatch, 2026-11-03).
{
  const { normalizeAnswers } = await import("../lib/human-choices.ts");
  const noted = [{ ...answers[0], note: "Keep the logo." }, answers[1]];
  const text = renderGroup(noted);
  assert.ok(text.includes("Theme: Which theme?\nSelected: A\nThe person also wrote: Keep the logo.\n\n"));
  assert.deepEqual(parseGroup(text), noted);
  assert.deepEqual(parseGroup(renderGroup(answers)), answers, "no note, no note key");
  assert.equal(normalizeAnswers([{ ...answers[1], note: "x" }]), null, "a decline has its reason, not a note");
  const free = { ...answers[0], choices: null, text: "My own answer." };
  assert.notEqual(normalizeAnswers([free]), null);
  assert.equal(normalizeAnswers([{ ...free, note: "x" }]), null, "a free reply is its text");
  for (const bad of ["", " ", null, 5, "x".repeat(4001)]) assert.equal(normalizeAnswers([{ ...answers[0], note: bad }]), null);
  const golden = JSON.parse(readFileSync(new URL("./questionnaire-note-snapshot.json", import.meta.url), "utf8"));
  assert.equal(renderGroup(golden.answers), golden.text, "shared Python/TypeScript group comment with a note");
  assert.deepEqual(parseGroup(golden.text), golden.answers);
  console.log("PASS questionnaire: a question keeps its note");
}
