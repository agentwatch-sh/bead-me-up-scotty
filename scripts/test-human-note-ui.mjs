// The operator's comment reaches the agent with every answer (agentwatch, 2026-11-03).
// API and browser checks on an isolated server and disposable bd board only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { parseChoice, parseGroup, parseNote, parseSelection, renderChoice } from "../lib/human-choices.ts";
const base = process.env.SCOTTY_TEST_URL;
const repo = process.env.SCOTTY_CHOICES_REPO;
assert.ok(base && repo, "Set SCOTTY_TEST_URL and SCOTTY_CHOICES_REPO to disposable fixtures");
const bd = (...args) => JSON.parse(execFileSync(process.env.SCOTTY_TEST_BD || "bd", args, { cwd: repo, encoding: "utf8" }));
const options = [
  { id: "green", label: "Use green", description: "Use a new green theme.", recommended: false },
  { id: "blue", label: "Use blue", description: "Use the existing blue theme.", recommended: true },
];
const blue = { version: 1, ...options[1] };
function create(metadata = { version: 1, options }) {
  const fields = metadata === null ? [] : ["--metadata", JSON.stringify({ "scotty.choices": metadata })];
  return bd("create", "Approve step 1?", "--type", "task", "--labels", "human,question", "--description", "Approve step 1. I recommend blue.", ...fields, "--json").id;
}
const comments = (id) => bd("comments", id, "--json");
const answer = (id) => comments(id).at(-1);
const reason = (id) => bd("show", id, "--json")[0].close_reason;
const NOTE = "Approve, but keep the old flag.\nAnd tell me when it ships.";

// API: a note that the text does not hold writes nothing.
{
  const id = create();
  const post = (body) => fetch(`${base}/api/p/choices/beads/${id}/human`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(base).origin }, body: JSON.stringify(body) });
  assert.equal((await post({ action: "respond", choice: blue, note: "Other words.", text: renderChoice(blue, NOTE) })).status, 400);
  assert.equal((await post({ action: "respond", choice: blue, note: " ", text: renderChoice(blue) })).status, 400);
  assert.equal(comments(id).length, 0, "a refused note writes no comment");
  assert.equal((await post({ action: "dismiss", choice: blue, note: NOTE, text: renderChoice(blue, NOTE) })).status, 200);
  assert.equal(answer(id).text, renderChoice(blue, NOTE));
  assert.equal(reason(id), "Dismissed");
  console.log("PASS human note API: the note binds the comment; Dismiss keeps it");
}

const browser = await chromium.launch({ executablePath: process.env.SCOTTY_BROWSER_EXECUTABLE || undefined });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // A list export already running when the item was created can answer without it
  // (as in test-review-ui.mjs): load again until the item shows.
  const visit = async (id, detail = false) => {
    const panel = page.locator(`[data-human-answer="${id}"]`);
    for (let attempt = 1; ; attempt++) {
      await page.goto(`${base}/p/choices?${detail ? `bead=${id}` : "view=needsyou"}`);
      try {
        await panel.getByRole("button", { name: /Dismiss|Respond/ }).first().waitFor({ timeout: 8000 });
        return panel;
      } catch (e) {
        if (attempt === 4) throw e;
      }
    }
  };
  const write = (panel, text) => panel.getByRole("textbox", { name: "Write an answer" }).fill(text);
  // The card leaves at the click (agentwatch age-6mk): the write is done when its confirmation shows.
  const written = async (panel, id) => {
    await panel.waitFor({ state: "detached" });
    await page.locator("[data-sonner-toast]").filter({ hasText: id }).filter({ hasNotText: "Sending" }).first().waitFor();
  };

  // A tap on an option sends the comment with it, in the inbox and in the drawer.
  for (const [detail, label, id] of [[false, /^Use green/, "green"], [true, /Use blue Recommended/, "blue"]]) {
    const item = create();
    const panel = await visit(item, detail);
    await write(panel, NOTE);
    await panel.getByText("Your comment goes with the option you tap.", { exact: true }).waitFor();
    await panel.getByRole("group", { name: "Answer choices" }).getByRole("button", { name: label }).click();
    await written(panel, item);
    assert.equal(parseChoice(answer(item).text).id, id);
    assert.equal(parseNote(answer(item).text), NOTE);
    assert.equal(answer(item).author, "human:selden");
    assert.equal(comments(item).length, 1, "one comment holds the choice and the note");
    assert.equal(reason(item), "Responded");
  }

  // A failed tap keeps the typed comment; the retry sends it.
  {
    const item = create();
    const panel = await visit(item);
    await write(panel, NOTE);
    await page.route(`**/beads/${item}/human`, (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "The board is restarting." }) }));
    await panel.getByRole("button", { name: /^Use green/ }).click();
    await panel.getByRole("alert").waitFor();
    assert.equal(await panel.getByRole("textbox", { name: "Write an answer" }).inputValue(), NOTE, "a failed write keeps the comment");
    await page.unroute(`**/beads/${item}/human`);
    await panel.getByRole("button", { name: /^Use green/ }).click();
    await written(panel, item);
    assert.equal(parseNote(answer(item).text), NOTE);
  }

  // Dismiss sends the recommendation with the comment.
  {
    const item = create();
    const panel = await visit(item);
    await write(panel, NOTE);
    await panel.getByText("Dismiss uses: Use blue. Your comment goes with it.", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
    await written(panel, item);
    assert.equal(parseChoice(answer(item).text).id, "blue");
    assert.equal(parseNote(answer(item).text), NOTE);
    assert.equal(reason(item), "Dismissed");
  }

  // Respond with selections sends them with the comment; neither replaces the other.
  {
    const item = create({ version: 1, options, multiSelect: true });
    const panel = await visit(item);
    const buttons = panel.getByRole("group", { name: "Answer choices" }).getByRole("button");
    await buttons.nth(0).click();
    await buttons.nth(1).click();
    await write(panel, NOTE);
    await panel.getByText("Respond sends the selected options with your comment.", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Respond", exact: true }).click();
    await written(panel, item);
    assert.deepEqual(parseSelection(answer(item).text).map((c) => c.id), ["blue", "green"]);
    assert.equal(parseNote(answer(item).text), NOTE);
  }

  // An item with no choices: Dismiss keeps the comment as its own comment.
  {
    const item = create(null);
    const panel = await visit(item);
    await write(panel, NOTE);
    await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
    await written(panel, item);
    assert.equal(answer(item).text, NOTE);
    assert.equal(reason(item), "Dismissed");
  }

  // Decline: the typed text is the reason, as before.
  {
    const item = create();
    const panel = await visit(item);
    await write(panel, "The premise is wrong.");
    await panel.getByRole("button", { name: "Decline question", exact: true }).click();
    await written(panel, item);
    assert.match(answer(item).text, /^The person declined this question: The premise is wrong\./);
    assert.equal(reason(item), "Declined");
  }

  // Several questions: each question's comment goes with its choice, and with Dismiss.
  {
    const questions = ["Theme", "Format"].map((header, i) => ({ id: `q${i + 1}`, question: `Choose ${header.toLowerCase()}?`, header, multiSelect: false, options }));
    const item = create({ version: 2, questions });
    let panel = await visit(item);
    await panel.locator('[data-question-id="q1"]').getByRole("button", { name: /Use blue Recommended/ }).click();
    await panel.getByRole("textbox", { name: "Answer for Theme" }).fill("Keep the logo.");
    await panel.locator('[data-question-id="q1"]').getByText("Your comment goes with the selected options.", { exact: true }).waitFor();
    await panel.locator('[data-question-id="q2"]').getByRole("button", { name: /^Use green/ }).click();
    await panel.getByRole("button", { name: "Respond", exact: true }).click();
    await written(panel, item);
    const group = parseGroup(answer(item).text);
    assert.deepEqual(group.map((a) => [a.choices.map((c) => c.id), a.note]), [[["blue"], "Keep the logo."], [["green"], undefined]]);

    const dismissed = create({ version: 2, questions });
    panel = await visit(dismissed);
    await panel.getByRole("textbox", { name: "Answer for Format" }).fill("Plain text is fine.");
    await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
    await written(panel, dismissed);
    const kept = parseGroup(answer(dismissed).text);
    assert.deepEqual(kept.map((a) => [a.choices.map((c) => c.id), a.note]), [[["blue"], undefined], [["blue"], "Plain text is fine."]]);
    assert.equal(reason(dismissed), "Dismissed");
  }
  await context.close();
  assert.deepEqual(errors, []);
  console.log("PASS human note UI: tap, drawer, failed write, Dismiss, selections, no choices, decline, groups");
} finally { await browser.close(); }
