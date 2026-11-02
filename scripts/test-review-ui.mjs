// Browser checks for the To Review view, on an isolated server and a disposable bd board only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { renderChoice } from "../lib/human-choices.ts";
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
const choice = (o) => ({ version: 1, ...o });

// An item as the manager leaves it: the review record, the answer comment, the close.
function managerAnswered(title, { free = false } = {}) {
  const meta = free ? {} : { "scotty.choices": { version: 1, options: [green, blue] } };
  const id = bd("create", title, "--type", "task", "--labels", "human,question", "--metadata", JSON.stringify(meta), "--json").id;
  run(MANAGER, ["update", id, "--set-metadata", "board.review=pending", "--set-metadata", `board.review_by=${MANAGER}`, "--set-metadata", "board.review_reason=Blue is the default."]);
  run(MANAGER, ["comment", id, free ? "Ship it on Friday." : renderChoice(choice(blue))]);
  run(MANAGER, ["close", id, "--reason", "Responded"]);
  return id;
}
const show = (id) => bd("show", id, "--json")[0];
const comments = (id) => bd("comments", id, "--json");
// Start from an empty review list: accept whatever an earlier run left pending.
for (const b of bd("list", "--all", "--json", "--limit", "0")) {
  if (b.metadata?.["board.review"] === "pending") run("human:selden", ["update", b.id, "--set-metadata", "board.review=accepted"]);
}

const browser = await chromium.launch({ executablePath: process.env.SCOTTY_BROWSER_EXECUTABLE || undefined });
const errors = [];
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  const nav = () => page.locator("nav").getByRole("button", { name: /^To Review/ });
  const open = async () => { await page.goto(`${base}/p/${project}?view=toreview`); await page.getByRole("heading", { name: "To Review" }).waitFor(); };
  const row = (id) => page.locator(`[data-review-row="${id}"]`);

  // No pending item: the nav item is hidden on another view, and the open view says so.
  await page.goto(`${base}/p/${project}?view=needsyou`);
  await page.getByRole("heading", { name: "Needs You" }).waitFor();
  const needsYou = () => page.locator("nav").getByRole("button", { name: /^Needs You/ }).innerText();
  await page.waitForFunction(() => document.querySelector("nav")?.textContent?.includes("Needs You"));
  await page.waitForTimeout(1500); // the beads load after the shell
  const needsYouBefore = await needsYou();
  assert.equal(await nav().count(), 0, "hidden with nothing to review");
  await open();
  await page.getByText("· nothing to review").waitFor();
  assert.equal(await page.getByRole("button", { name: /^Accept all/ }).count(), 0);

  // One pending item: the badge, the row, Accept.
  const one = managerAnswered("Which theme?");
  await page.goto(`${base}/p/${project}?view=needsyou`);
  await nav().waitFor();
  await page.waitForTimeout(500);
  assert.equal((await nav().innerText()).replace(/\s+/g, " ").trim(), "To Review 1");
  assert.equal(await needsYou(), needsYouBefore, "nothing is added to Needs You");
  await nav().click();
  await page.getByText("· 1 answers by your manager").waitFor();
  await row(one).waitFor();
  const text = await row(one).innerText();
  assert.match(text, /Which theme\?/);
  assert.match(text, /Manager's answer\s+Use blue/);
  assert.match(text, /Why\s+Blue is the default\./);
  assert.match(text, /Asked by/);
  // Keyboard: Tab to Accept, Enter.
  const accept = row(one).getByRole("button", { name: "Accept", exact: true });
  await accept.focus();
  await page.keyboard.press("Enter");
  await row(one).waitFor({ state: "detached" });
  assert.equal(show(one).metadata["board.review"], "accepted");
  assert.equal(show(one).metadata["board.reviewed_by"], "human:selden");
  assert.ok(show(one).metadata["board.reviewed_at"]);
  await page.getByText("· nothing to review").waitFor();
  assert.equal(await page.getByRole("button", { name: /^Accept all/ }).count(), 0);

  // Tab order reaches Accept without a mouse.
  const tabbed = managerAnswered("Which theme again?");
  await open();
  await row(tabbed).waitFor();
  await row(tabbed).getByRole("button", { name: tabbed }).focus(); // the row's first control
  let reached = false;
  for (let i = 0; i < 6 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.textContent?.trim() === "Accept");
  }
  assert.ok(reached, "Tab reaches Accept");
  await page.keyboard.press("Enter");
  await row(tabbed).waitFor({ state: "detached" });
  assert.equal(show(tabbed).metadata["board.review"], "accepted");

  // Accept all asks once, then accepts every pending row, one request each.
  const many = [managerAnswered("Theme A?"), managerAnswered("Theme B?"), managerAnswered("Theme C?")];
  await open();
  for (const id of many) await row(id).waitFor();
  const requests = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/review")) requests.push(r.url()); });
  const dialogs = [];
  page.once("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.getByRole("button", { name: "Accept all (3)" }).click();
  assert.deepEqual(dialogs, ["Accept all 3 answers?"]);
  assert.equal(requests.length, 0, "a cancelled confirm accepts nothing");
  page.once("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.getByRole("button", { name: "Accept all (3)" }).click();
  for (const id of many) await row(id).waitFor({ state: "detached" });
  assert.equal(dialogs.length, 2, "one confirm per click");
  assert.equal(requests.length, 3, "one request per item");
  for (const id of many) assert.equal(show(id).metadata["board.review"], "accepted");

  // Reverse: the controls, the note, the submit.
  const rev = managerAnswered("Which theme to reverse?");
  await open();
  await row(rev).getByRole("button", { name: "Reverse", exact: true }).click();
  await row(rev).getByText("Your answer replaces the manager's. The asking agent gets it as a new answer from you.").waitFor();
  const panel = row(rev).locator(`[data-human-answer="${rev}"]`);
  await panel.getByRole("button", { name: /Use green/ }).click();
  await row(rev).waitFor({ state: "detached" });
  const reversed = show(rev);
  assert.equal(reversed.status, "closed");
  assert.equal(reversed.metadata["board.review"], "reversed");
  assert.equal(reversed.metadata["board.reviewed_by"], "human:selden");
  const last = comments(rev).at(-1);
  assert.equal(last.author, "human:selden");
  assert.match(last.text, /Selected: Use green/);

  // A free-text item has no options: Dismiss is hidden in Reverse, a written answer works.
  const freeId = managerAnswered("Ship when?", { free: true });
  await open();
  assert.match(await row(freeId).innerText(), /Manager's answer\s+Ship it on Friday\./);
  await row(freeId).getByRole("button", { name: "Reverse", exact: true }).click();
  assert.equal(await row(freeId).getByRole("button", { name: "Dismiss", exact: true }).count(), 0, "no Dismiss without options");
  await row(freeId).getByRole("textbox", { name: "Write an answer" }).fill("Ship on Monday.");
  await row(freeId).getByRole("button", { name: "Respond", exact: true }).click();
  await row(freeId).waitFor({ state: "detached" });
  assert.equal(comments(freeId).at(-1).text, "Ship on Monday.");
  assert.equal(show(freeId).metadata["board.review"], "reversed");

  // A Reverse that did not start keeps the row, the error and what was typed.
  const failing = managerAnswered("Ship later?", { free: true });
  await open();
  await row(failing).getByRole("button", { name: "Reverse", exact: true }).click();
  const input = row(failing).getByRole("textbox", { name: "Write an answer" });
  await input.fill("Not on Friday.");
  await page.route(`**/beads/${failing}/review`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The reverse did not start. Try again.", code: "reverse_not_started" }) }));
  await row(failing).getByRole("button", { name: "Respond", exact: true }).click();
  await row(failing).getByRole("alert").waitFor();
  assert.match(await row(failing).getByRole("alert").innerText(), /did not start/);
  assert.equal(await input.inputValue(), "Not on Friday.", "the typed answer stays");
  assert.equal(await row(failing).count(), 1, "the row stays");
  await page.unroute(`**/beads/${failing}/review`);
  assert.equal(show(failing).metadata["board.review"], "pending");

  // Mobile: the row and its buttons fit.
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await row(failing).waitFor();
  assert.ok(await noOverflow(page), "no horizontal scroll at 390 px (collapsed row)");
  await row(failing).getByRole("button", { name: "Reverse", exact: true }).click();
  assert.ok(await noOverflow(page), "no horizontal scroll at 390 px (Reverse open)");
  const box = await row(failing).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, "the row fits the viewport");
  run("human:selden", ["update", failing, "--set-metadata", "board.review=accepted"]);

  // Read-only: every control is disabled.
  const ro = managerAnswered("Read-only theme?");
  await context.addCookies([{ name: "scotty-viewer-mode", value: "read-only", url: new URL(base).origin }]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open();
  await row(ro).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Accept all/ }).isDisabled(), true);
  assert.equal(await row(ro).getByRole("button", { name: "Accept", exact: true }).isDisabled(), true);
  assert.equal(await row(ro).getByRole("button", { name: "Reverse", exact: true }).isDisabled(), true);
  run("human:selden", ["update", ro, "--set-metadata", "board.review=accepted"]);

  await context.close();
  assert.deepEqual(errors, []);
  console.log("PASS review UI: badge, hidden, Accept, keyboard, Accept all, Reverse, no-options, failed reverse, mobile, read-only");
} finally { await browser.close(); }
