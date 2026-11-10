import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { renderGroup, parseGroup } from "../lib/human-choices.ts";
const base = process.env.SCOTTY_TEST_URL;
const repo = process.env.SCOTTY_CHOICES_REPO;
assert.ok(base && repo, "Use an isolated server and disposable bd repository");
const bd = (...args) => JSON.parse(execFileSync(process.env.SCOTTY_TEST_BD || "bd", args, { cwd: repo, encoding: "utf8" }));
const options = [{id:"blue",label:"Use blue",description:"Keep blue.",recommended:true},{id:"green",label:"Use green",description:"Create green.",recommended:false}];
const questions = ["Theme", "Colors", "Format", "Scope"].map((header,i)=>({id:`q${i+1}`,question:`Choose ${header.toLowerCase()}?`,header,multiSelect:i===1,options}));
const definition = {version:2,questions};
const create = () => bd("create","Answer the page questions","--type","task","--labels","human,question","--metadata",JSON.stringify({"scotty.choices":definition}),"--json").id;
const answer = (q, choices = [{version:1,...options[0]}], text = null, action = "responded") => ({id:q.id,question:q.question,header:q.header,multiSelect:q.multiSelect,action,choices,text});
const answers=[answer(questions[0]),answer(questions[1],options.map((o)=>({version:1,...o}))),answer(questions[2],null,"Use plain text."),answer(questions[3],null,"The premise is wrong.","declined")];
const post=(id,entries,action="respond")=>fetch(`${base}/api/p/choices/beads/${id}/human`,{method:"POST",headers:{"content-type":"application/json",origin:new URL(base).origin,cookie:"scotty-viewer-mode=editing"},body:JSON.stringify({action,answers:entries,text:renderGroup(entries)})});
const id=create();
assert.equal((await post(id,answers.slice(0,3))).status,409,"every question needs an answer or decline");
assert.equal(bd("comments",id,"--json").length,0,"an incomplete group writes no comment");
assert.equal((await post(id,answers.map((a,i)=>i===0?{...a,question:"Changed premise?"}:a))).status,409,"stale question snapshot");
assert.equal((await post(id,answers)).status,200);
const comments=bd("comments",id,"--json");
assert.equal(comments.length,1,"one group writes one comment");
assert.equal(comments[0].author,"human:selden");
assert.deepEqual(parseGroup(comments[0].text),answers);
assert.equal(bd("show",id,"--json")[0].close_reason,"Responded");
const dismissed=create();
assert.equal((await post(dismissed,questions.map((q)=>answer(q)),"dismiss")).status,200);
assert.equal(bd("show",dismissed,"--json")[0].close_reason,"Dismissed");
assert.equal(bd("comments",dismissed,"--json").length,1);
console.log("PASS questionnaire API: complete/stale groups, one comment, mixed answers, recommended Dismiss");

const browser=await chromium.launch({executablePath:process.env.SCOTTY_BROWSER_EXECUTABLE||undefined});
try{
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.addCookies([{name:"scotty-viewer-mode",value:"editing",url:new URL(base).origin}]);
 const page=await context.newPage();
 const errors=[];page.on("pageerror",(error)=>errors.push(error.message));
 for(const detail of [false,true]){
  const item=create();let writes=0;
  page.on("request",(request)=>{if(request.method()==="POST"&&request.url().endsWith(`/beads/${item}/human`))writes++;});
  await page.goto(`${base}/p/choices?${detail?`bead=${item}`:"view=needsyou"}`);
  const panel=page.locator(`[data-human-answer="${item}"]`);
  const submit=panel.getByRole("button",{name:"Respond",exact:true});await submit.waitFor();
  assert.equal(await submit.isDisabled(),true);
  await panel.locator('[data-question-id="q1"]').getByRole("button",{name:/Use blue Recommended/}).click();
  assert.equal(await submit.isDisabled(),true,"one answered question does not submit the item");
  const colors=panel.locator('[data-question-id="q2"]');
  await colors.getByRole("button",{name:/Use blue Recommended/}).click();
  await colors.getByRole("button",{name:/Use green/}).click();
  await panel.getByRole("textbox",{name:"Answer for Format"}).fill("Use plain text.");
  const scope=panel.locator('[data-question-id="q4"]');
  assert.equal(await scope.getByRole("button",{name:"Decline question",exact:true}).isDisabled(),true);
  await panel.getByRole("textbox",{name:"Answer for Scope"}).fill("The premise is wrong.");
  await scope.getByRole("button",{name:"Decline question",exact:true}).click();
  assert.equal(writes,0,"preset taps and per-question decline do not submit");
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
  await submit.click();await panel.waitFor({state:"detached"});
  // The card leaves at the click (agentwatch age-6mk): the write is done when its confirmation shows.
  await page.locator("[data-sonner-toast]").filter({hasText:item}).filter({hasNotText:"Sending"}).first().waitFor();
  assert.equal(writes,1,"one final request for every question");
  const saved=bd("comments",item,"--json");assert.equal(saved.length,1);
  assert.deepEqual(parseGroup(saved[0].text),answers);
 }
 await context.close();assert.deepEqual(errors,[]);
 console.log("PASS questionnaire UI: inbox/detail, all answer types, submit once, mobile");
}finally{await browser.close();}
