// Browser regression checks on an isolated server and disposable bd board only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { parseChoice, parseSelection } from "../lib/human-choices.ts";
const base = process.env.SCOTTY_TEST_URL;
const repo = process.env.SCOTTY_CHOICES_REPO;
assert.ok(base && repo, "Set SCOTTY_TEST_URL and SCOTTY_CHOICES_REPO to disposable fixtures");
const bd = (...args) => JSON.parse(execFileSync(process.env.SCOTTY_TEST_BD || "bd", args, { cwd: repo, encoding: "utf8" }));
const options = [
  { id: "green", label: "Use green", description: "Use a new green theme.", recommended: false },
  { id: "blue", label: "Use blue", description: "Use the existing blue theme.", recommended: true },
];
function create(metadata = { version: 1, options }) {
  return bd("create", "Choose the page theme", "--type", "task", "--labels", "human,question", "--description", "Choose the page theme. I recommend blue.", "--metadata", JSON.stringify({ "scotty.choices": metadata }), "--json").id;
}
const answer = (id) => bd("comments", id, "--json").at(-1);
const browser = await chromium.launch({ executablePath: process.env.SCOTTY_BROWSER_EXECUTABLE || undefined });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const visit = async (id, detail = false) => {
    await page.goto(`${base}/p/choices?${detail ? `bead=${id}` : "view=needsyou"}`);
    const panel = page.locator(`[data-human-answer="${id}"]`);
    await panel.getByRole("textbox", { name: "Write an answer" }).waitFor();
    return panel;
  };
  const id = create();
  let panel = await visit(id);
  const buttons = panel.getByRole("group", { name: "Answer choices" }).getByRole("button");
  assert.match(await buttons.first().innerText(), /^Use blue\s+Recommended/);
  await buttons.nth(1).focus();
  await page.keyboard.press("Enter");
  await panel.waitFor({ state: "detached" });
  assert.equal(parseChoice(answer(id).text).id, "green");
  assert.equal(answer(id).author, "human:selden");

  const drawer = create();
  panel = await visit(drawer, true);
  await panel.getByRole("button", { name: /Use blue Recommended/ }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(parseChoice(answer(drawer).text).id, "blue");

  await page.setViewportSize({ width: 390, height: 844 });
  const dismissed = create();
  panel = await visit(dismissed);
  await panel.getByText("Dismiss uses: Use blue.", { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await panel.getByRole("button", { name: "Dismiss", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(parseChoice(answer(dismissed).text).id, "blue");
  assert.equal(bd("show", dismissed, "--json")[0].close_reason, "Dismissed");

  const free = create();
  panel = await visit(free);
  const input = panel.getByRole("textbox", { name: "Write an answer" });
  await input.fill("Use another theme.");
  await page.route(`**/beads/${free}/human`, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "The choices changed." }) }));
  await panel.getByRole("button", { name: "Respond", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  assert.equal(await input.inputValue(), "Use another theme.", "failed answer preserves free text");
  await page.unroute(`**/beads/${free}/human`);
  await panel.getByRole("button", { name: "Respond", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(answer(free).text, "Use another theme.");

  const multiple = create({ version: 1, options, multiSelect: true });
  panel = await visit(multiple);
  const choiceButtons = panel.getByRole("group", { name: "Answer choices" }).getByRole("button");
  await choiceButtons.nth(0).click();
  await choiceButtons.nth(1).click();
  assert.equal(await choiceButtons.nth(0).getAttribute("aria-pressed"), "true");
  assert.equal(await choiceButtons.nth(1).getAttribute("aria-pressed"), "true");
  assert.equal(bd("comments", multiple, "--json").length, 0, "selection taps do not submit a multi-select question");
  await panel.getByRole("button", { name: "Respond", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.deepEqual(parseSelection(answer(multiple).text).map((c) => c.id), ["blue", "green"]);

  for (const detail of [false, true]) {
    const declined = create();
    panel = await visit(declined, detail);
    const declineButton = panel.getByRole("button", { name: "Decline question", exact: true });
    assert.equal(await declineButton.isDisabled(), true, "decline requires a reason");
    await panel.getByRole("textbox", { name: "Write an answer" }).fill("The premise is wrong.");
    await declineButton.click();
    await panel.waitFor({ state: "detached" });
    assert.equal(bd("show", declined, "--json")[0].close_reason, "Declined");
    assert.match(answer(declined).text, /^The person declined this question: The premise is wrong\./);
  }

  const legacy = create({ version: 99, options });
  panel = await visit(legacy);
  assert.equal(await panel.getByRole("group", { name: "Answer choices" }).count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Dismiss", exact: true }).isEnabled(), true);

  await context.addCookies([{ name: "scotty-viewer-mode", value: "read-only", url: new URL(base).origin }]);
  const readOnly = create();
  panel = await visit(readOnly);
  assert.equal(await panel.getByRole("button", { name: /Use blue Recommended/ }).isDisabled(), true);
  assert.equal(await panel.getByRole("textbox").isDisabled(), true);
  await context.close();
  assert.deepEqual(errors, []);
  console.log("PASS human choices UI: inbox, detail, keyboard, mobile, Dismiss, free text, errors, legacy, read-only");
} finally { await browser.close(); }
