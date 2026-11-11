// An answered item leaves its list at the click (agentwatch board age-6mk).
// Browser checks on an isolated server and a disposable bd board only. Start the
// server with BD_BIN=scripts/slow-bd.sh, SCOTTY_SLOW_BD_REAL=<the real bd> and
// SCOTTY_SLOW_BD_DIR=<a control folder>, and pass the same folder here: the test
// makes the server's bd slow, or makes one write fail, through files in it.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { parseChoice, parseNote, renderChoice } from "../lib/human-choices.ts";
const base = process.env.SCOTTY_TEST_URL;
const repo = process.env.SCOTTY_CHOICES_REPO;
const control = process.env.SCOTTY_SLOW_BD_DIR;
const project = process.env.SCOTTY_TEST_PROJECT || "choices";
assert.ok(base && repo && control, "Set SCOTTY_TEST_URL, SCOTTY_CHOICES_REPO and SCOTTY_SLOW_BD_DIR to disposable fixtures");
const bin = process.env.SCOTTY_TEST_BD || "bd";
const MANAGER = "manager:test/manager";
const run = (actor, args) => execFileSync(bin, args, { cwd: repo, encoding: "utf8", env: { ...process.env, BEADS_ACTOR: actor } });
// The same, without blocking the test process (inside a route handler, while the page is timed).
const runAsync = (actor, args) => promisify(execFile)(bin, args, { cwd: repo, encoding: "utf8", env: { ...process.env, BEADS_ACTOR: actor } });
const bd = (...args) => JSON.parse(run("agent:test", args));
const show = (id) => bd("show", id, "--json")[0];
const comments = (id) => bd("comments", id, "--json");
// The operator's answer comments on an item.
const mine = (id) => comments(id).filter((c) => c.author === "human:selden");
// The server's bd: wait before a command, or fail one command on one item.
const slow = (command, seconds) => fs.writeFileSync(path.join(control, `delay-${command}`), String(seconds));
const fast = (command) => fs.rmSync(path.join(control, `delay-${command}`), { force: true });
const refuse = (command, id) => fs.writeFileSync(path.join(control, `fail-${command}-${id}`), "");
const allow = (command, id) => fs.rmSync(path.join(control, `fail-${command}-${id}`), { force: true });
const SLOW_S = 3;
// The neutral words of an answer whose item is closed now (lib/answer-outbox.ts).
const CLOSED_NOW = "This question is closed now. Your answer may or may not be the one recorded: open the item to check.";
const NOTE = "Approve, but keep the old flag.";

const green = { id: "green", label: "Use green", description: "Use a new green theme.", recommended: false };
const blue = { id: "blue", label: "Use blue", description: "Use the existing blue theme.", recommended: true };
function create(title, metadata = { version: 1, options: [green, blue] }) {
  const fields = metadata === null ? [] : ["--metadata", JSON.stringify({ "scotty.choices": metadata })];
  return bd("create", title, "--type", "task", "--labels", "human,question", ...fields, "--json").id;
}
// An item as the manager leaves it in To Review: the review record, the answer, the close.
function managerAnswered(title) {
  const id = bd("create", title, "--type", "task", "--labels", "human,question", "--metadata", JSON.stringify({ "scotty.choices": { version: 1, options: [green, blue] } }), "--json").id;
  run(MANAGER, ["update", id, "--set-metadata", "board.review=pending", "--set-metadata", `board.review_by=${MANAGER}`, "--set-metadata", "board.review_reason=Blue is the default."]);
  run(MANAGER, ["comment", id, renderChoice({ version: 1, ...blue })]);
  run(MANAGER, ["close", id, "--reason", "Responded"]);
  return id;
}

const browser = await chromium.launch({ executablePath: process.env.SCOTTY_BROWSER_EXECUTABLE || undefined });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  const listPath = `/api/p/${project}/beads`;
  const painted = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  // Load a view and wait until the bead list has arrived and rendered.
  const load = async (query) => {
    const listed = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname.endsWith(listPath));
    await page.goto(`${base}/p/${project}?${query}`);
    await listed;
    await painted();
  };
  const panelOf = (id) => page.locator(`[data-human-answer="${id}"]`);
  const visit = async (id, query = "view=needsyou") => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await load(query);
      if (await panelOf(id).count()) return panelOf(id);
    }
    throw new Error(`the answer form of ${id} did not show`);
  };
  const toast = (text) => page.locator("[data-sonner-toast]").filter({ hasText: text });
  // The time from a click to the card's leaving: the write itself waits SLOW_S seconds.
  const leaves = async (locator, click) => {
    const start = Date.now();
    await click();
    await locator.waitFor({ state: "detached", timeout: 5000 });
    return Date.now() - start;
  };
  const needsYouCount = async () => {
    const text = await page.locator("nav").getByRole("button", { name: /^Needs You/ }).innerText();
    return Number(text.replace(/\D+/g, "") || 0);
  };
  // Re-ask for the list now (react-query refetches on a visibility change).
  const refetch = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));

  // ---- Respond: out at the click, out while an older list arrives, then the confirmation ----
  {
    const item = create("Approve the theme?");
    const panel = await visit(item);
    await panel.getByRole("textbox", { name: "Write an answer" }).fill(NOTE);
    // The list as it was before the answer: the item open. An older list returns it.
    const older = await (await page.request.get(`${base}${listPath}`)).json();
    assert.ok(older.beads.some((b) => b.id === item && b.status === "open"));
    let olderServed = 0;
    const held = [];
    let mode = "pass";
    await page.route(`**${listPath}`, async (route) => {
      if (mode === "older") { olderServed++; return route.fulfill({ json: older }); }
      // Hold the one request made during the POST; the lists after the 2xx reach the board.
      if (mode === "hold") { held.push(route); mode = "pass"; return; }
      return route.continue();
    });
    const before = await needsYouCount();
    slow("close", SLOW_S);
    const posted = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/beads/${item}/human`), { timeout: 30000 });
    let postDone = false;
    void posted.then(() => { postDone = true; }, () => {});
    const ms = await leaves(panel, () => panel.getByRole("group", { name: "Answer choices" }).getByRole("button", { name: /^Use green/ }).click());
    assert.ok(ms < 1000, `the card left ${ms} ms after the click, while the write ran`);
    await toast(`Sending your answer to ${item}…`).waitFor();
    assert.equal(await needsYouCount(), before - 1, "the Needs You count drops at the click");
    // An older list during the POST: the card stays out.
    mode = "older";
    await refetch();

    for (let i = 0; i < 50 && olderServed === 0; i++) await new Promise((done) => setTimeout(done, 100));
    assert.ok(olderServed > 0, "an older list was served during the POST");
    await painted();
    assert.equal(await panelOf(item).count(), 0, "an older list during the POST does not bring the card back");
    // A list requested during the POST that arrives after it: still out.
    mode = "hold";
    await refetch();
    for (let i = 0; i < 50 && held.length === 0; i++) await new Promise((done) => setTimeout(done, 100));
    assert.ok(held.length > 0, "a list request is held across the POST");
    assert.equal(postDone, false, "the held list was requested while the POST ran");
    const response = await posted;
    assert.equal(response.status(), 200);
    await toast(`Responded to ${item}`).waitFor();
    for (const route of held.splice(0)) await route.fulfill({ json: older }).catch(() => {});
    await painted();
    assert.equal(await panelOf(item).count(), 0, "an older list after the POST does not bring the card back");
    mode = "pass";
    await page.unroute(`**${listPath}`);
    fast("close");
    // The board has the answer, and a fresh list agrees.
    assert.equal(show(item).close_reason, "Responded");
    assert.equal(parseChoice(comments(item).at(-1).text).id, "green");
    assert.equal(parseNote(comments(item).at(-1).text), NOTE);
    await load("view=needsyou");
    assert.equal(await panelOf(item).count(), 0);
    console.log(`PASS answer speed: the card left ${ms} ms after the click; older lists during and after the POST kept it out; the confirmation came after the 2xx`);
  }

  // ---- A failed close: the card comes back in its place, with its error and the typed text ----
  {
    const item = create("Ship it on Friday?", null);
    const panel = await visit(item);
    await panel.getByRole("textbox", { name: "Write an answer" }).fill("Ship on Monday.");
    slow("close", 1);
    refuse("close", item);
    const ms = await leaves(panel, () => panel.getByRole("button", { name: "Respond", exact: true }).click());
    assert.ok(ms < 1000, `the card left ${ms} ms after the click`);
    await panelOf(item).getByRole("alert").waitFor();
    assert.equal(await panelOf(item).getByRole("alert").innerText(), "Your answer is saved; closing failed: try again.", "the answer is saved; only the close failed");
    assert.equal(await panelOf(item).getByRole("textbox", { name: "Write an answer" }).inputValue(), "Ship on Monday.", "the typed text is back");
    assert.equal(show(item).status, "open", "the item is still open");
    // The retry goes through.
    allow("close", item);
    fast("close");
    await leaves(panelOf(item), () => panelOf(item).getByRole("button", { name: "Respond", exact: true }).click());
    await toast(`Responded to ${item}`).waitFor();
    assert.equal(show(item).close_reason, "Responded");
    assert.equal(mine(item).length, 1, "one answer comment after the failed close and the retry");
    console.log("PASS answer speed: a failed close brings the card back saying the answer is saved; the retry only closes (one answer comment)");
  }

  // ---- A group of questions: out at the click; a failure keeps every question's draft ----
  {
    const questions = ["Theme", "Format"].map((header, i) => ({ id: `q${i + 1}`, question: `Choose ${header.toLowerCase()}?`, header, multiSelect: false, options: [green, blue] }));
    const item = create("Two questions?", { version: 2, questions });
    const panel = await visit(item);
    await panel.locator('[data-question-id="q1"]').getByRole("button", { name: /^Use green/ }).click();
    await panel.getByRole("textbox", { name: "Answer for Theme" }).fill("Keep the logo.");
    await panel.locator('[data-question-id="q2"]').getByRole("button", { name: /Use blue/ }).click();
    slow("close", 1);
    refuse("close", item);
    const ms = await leaves(panel, () => panel.getByRole("button", { name: "Respond", exact: true }).click());
    assert.ok(ms < 1000, `the group left ${ms} ms after the click`);
    await panelOf(item).getByRole("alert").waitFor();
    assert.equal(await panelOf(item).getByRole("alert").innerText(), "Your answer is saved; closing failed: try again.");
    assert.equal(await panelOf(item).getByRole("textbox", { name: "Answer for Theme" }).inputValue(), "Keep the logo.");
    assert.equal(await panelOf(item).locator('[data-question-id="q1"]').getByRole("button", { name: /^Use green/ }).getAttribute("aria-pressed"), "true", "the chosen option is back");
    allow("close", item);
    slow("close", SLOW_S);
    const again = await leaves(panelOf(item), () => panelOf(item).getByRole("button", { name: "Respond", exact: true }).click());
    assert.ok(again < 1000, `the group left ${again} ms after the second click`);
    await toast(`Answered ${item}`).waitFor({ timeout: 30000 });
    fast("close");
    assert.equal(show(item).close_reason, "Responded");
    assert.equal(mine(item).length, 1, "one answer comment for the group after the failed close and the retry");
    console.log("PASS answer speed: a group of questions leaves at the click; a failure keeps every draft; one answer comment after the retry");
  }

  // ---- Decline and Dismiss leave at the click too ----
  for (const [action, button, done, reason] of [["decline", "Decline question", "Declined", "Declined"], ["dismiss", "Dismiss", "Dismissed", "Dismissed"]]) {
    const item = create(`Question to ${action}?`, null);
    const panel = await visit(item);
    if (action === "decline") await panel.getByRole("textbox", { name: "Write an answer" }).fill("The premise is wrong.");
    slow("close", SLOW_S);
    const ms = await leaves(panel, () => panel.getByRole("button", { name: button, exact: true }).click());
    assert.ok(ms < 1000, `${action}: the card left ${ms} ms after the click`);
    await toast(`${done} ${item}`).waitFor({ timeout: 30000 });
    fast("close");
    assert.equal(show(item).close_reason, reason);
  }
  console.log("PASS answer speed: Decline and Dismiss leave at the click");

  // ---- Refusals, a dropped connection and a hung request: the card comes back (review I2, I3) ----
  {
    const typed = "Ship it on Monday.";
    const cases = [
      ["the proxy refuses an agent's login (403)", (route) => route.fulfill({ status: 403, json: { error: "Answers and comments need the operator's password login.", error_code: "password_login_required" } }), /need the operator's password login/],
      ["the board says the question is stale (409)", (route) => route.fulfill({ status: 409, json: { error: "This question is no longer waiting for an answer.", code: "stale_question" } }), /no longer waiting for an answer/],
      ["the proxy answers 409 with its login chooser page", (route) => route.fulfill({ status: 409, contentType: "text/html", body: "<html>Choose a board</html>" }), /Request failed \(409\)/],
      ["the connection drops", (route) => route.abort("failed"), /did not reach the board: the connection failed/],
      ["the request hangs", () => {}, /did not answer within 30 s/],
    ];
    for (const [name, answerWith, expected] of cases) {
      const item = create(`Refused: ${name}?`, null);
      const panel = await visit(item);
      await panel.getByRole("textbox", { name: "Write an answer" }).fill(typed);
      const pending = [];
      // The answer comes 1.5 s later, so the test sees the card leave and then come back.
      await page.route(`**/beads/${item}/human`, async (route) => {
        pending.push(route);
        await new Promise((done) => setTimeout(done, 1500));
        return answerWith(route);
      });
      const ms = await leaves(panel, () => panel.getByRole("button", { name: "Respond", exact: true }).click());
      assert.ok(ms < 1000, `${name}: the card left ${ms} ms after the click`);
      await panelOf(item).getByRole("alert").waitFor({ timeout: 45000 });
      assert.match(await panelOf(item).getByRole("alert").innerText(), expected, name);
      assert.equal(await panelOf(item).getByRole("textbox", { name: "Write an answer" }).inputValue(), typed, `${name}: the typed text is back`);
      assert.equal(mine(item).length, 0, `${name}: nothing was written`);
      // An edit deals with the failure: its error goes (review M2).
      await panelOf(item).getByRole("textbox", { name: "Write an answer" }).fill(`${typed} Edited.`);
      await panelOf(item).getByRole("alert").waitFor({ state: "detached" });
      await page.unroute(`**/beads/${item}/human`);
      for (const route of pending) await route.abort().catch(() => {});
    }
    console.log("PASS answer speed: a 403, a 409 (JSON and HTML), a dropped connection and a hung request bring the card back with its error and the typed text; an edit clears the error");
  }

  // ---- The board wrote the answer, but its response was lost: the neutral words, never "sent" (re-check rv-6mk-d) ----
  {
    const typed = "Ship it.";
    const item = create("Lost response?", null);
    const panel = await visit(item);
    await panel.getByRole("textbox", { name: "Write an answer" }).fill(typed);
    await page.route(`**/beads/${item}/human`, async (route) => {
      await route.fetch(); // the board takes the answer
      await route.abort("failed"); // and the page never hears it
    });
    await leaves(panel, () => panel.getByRole("button", { name: "Respond", exact: true }).click());
    await panelOf(item).getByRole("alert").waitFor();
    assert.equal(await panelOf(item).getByRole("alert").innerText(), CLOSED_NOW);
    assert.equal(await panelOf(item).getByRole("textbox", { name: "Write an answer" }).inputValue(), typed, "the typed text is back");
    assert.equal(await toast(`Responded to ${item}`).count(), 0, "a closed item never reads as sent after a failure");
    await page.unroute(`**/beads/${item}/human`);
    await page.locator(`[data-closed-meanwhile="${item}"]`).getByRole("button", { name: "OK", exact: true }).click();
    await panelOf(item).waitFor({ state: "detached" });
    assert.equal(show(item).close_reason, "Responded");
    assert.equal(mine(item).length, 1);
    console.log("PASS answer speed: a lost response on an item now closed gives the neutral words and the typed text, never \"sent\"");
  }

  // ---- The request fails while a manager answers the item: never "sent" (re-check Important 1) ----
  {
    const typed = "Ship it on Monday.";
    const item = create("Someone else answers?", null);
    const panel = await visit(item);
    await panel.getByRole("textbox", { name: "Write an answer" }).fill(typed);
    await page.route(`**/beads/${item}/human`, async (route) => {
      // The manager answers and closes the item; the operator's request never reaches the board.
      await runAsync(MANAGER, ["comment", item, "Ship it on Friday."]);
      await runAsync(MANAGER, ["close", item, "--reason", "Responded"]);
      await new Promise((done) => setTimeout(done, 1000));
      await route.abort("failed");
    });
    const ms = await leaves(panel, () => panel.getByRole("button", { name: "Respond", exact: true }).click());
    assert.ok(ms < 1000, `the card left ${ms} ms after the click`);
    await panelOf(item).getByRole("alert").waitFor();
    // Closed now, by anyone: the neutral words, never "Responded" and never "not saved".
    assert.equal(await panelOf(item).getByRole("alert").innerText(), CLOSED_NOW);
    assert.equal(await panelOf(item).getByRole("textbox", { name: "Write an answer" }).inputValue(), typed, "the typed text is back");
    await page.locator(`[data-closed-meanwhile="${item}"]`).getByRole("button", { name: "OK", exact: true }).waitFor();
    assert.equal(await toast(`Responded to ${item}`).count(), 0, "the manager's close never reads as the operator's answer");
    // The page shows the item as the board has it now: its form is disabled at once, no second click.
    assert.equal(await panelOf(item).getByRole("button", { name: "Respond", exact: true }).isDisabled(), true, "the closed item's form is disabled");
    await page.unroute(`**/beads/${item}/human`);
    // A fresh list shows the item closed: the card stays until the operator dismisses it.
    const listed = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname.endsWith(listPath));
    await refetch();
    await listed;
    await painted();
    assert.equal(await panelOf(item).count(), 1, "the failed card stays although the item is closed");
    await page.locator(`[data-closed-meanwhile="${item}"]`).getByRole("button", { name: "OK", exact: true }).click();
    await panelOf(item).waitFor({ state: "detached" });
    assert.equal(mine(item).length, 0, "the operator's answer was not written");
    console.log("PASS answer speed: a manager's close during a failed request is not the operator's answer; the card stays with its error and text");
  }

  // ---- The recheck race: a new send while a recheck's read runs; the new try's result stands (re-check rv-6mk-d, Minor 3) ----
  {
    const typed = "Ship it on Tuesday.";
    const item = create("A recheck race?", null);
    const panel = await visit(item);
    await panel.getByRole("textbox", { name: "Write an answer" }).fill(typed);
    // Try 1 is dropped before the board; the read finds the item open: an uncertain failure.
    await page.route(`**/beads/${item}/human`, (route) => route.abort("failed"));
    await leaves(panel, () => panel.getByRole("button", { name: "Respond", exact: true }).click());
    await panelOf(item).getByRole("alert").waitFor();
    assert.match(await panelOf(item).getByRole("alert").innerText(), /did not reach the board/);
    // The next read of the item is held: the recheck's.
    const held = [];
    await page.route(new RegExp(`/beads/${item}$`), (route) => {
      if (held.length === 0 && route.request().method() === "GET") { held.push(route); return; }
      return route.continue();
    });
    // A list that shows the item closed starts the recheck, whose read is held ...
    const real = await (await page.request.get(`${base}${listPath}`)).json();
    const closedList = { ...real, beads: real.beads.map((b) => (b.id === item ? { ...b, status: "closed", close_reason: "Responded" } : b)) };
    await page.route(`**${listPath}`, (route) => route.fulfill({ json: closedList }));
    // A write elsewhere on the board sends the page its change event: it asks for the list.
    const other = bd("create", "Nudge the list", "--type", "task", "--json").id;
    const nudge = () => runAsync("agent:test", ["update", other, "--set-metadata", `nudge=${Date.now()}`]);
    await nudge();
    for (let i = 0; i < 100 && held.length === 0; i++) await new Promise((done) => setTimeout(done, 100));
    assert.equal(held.length, 1, "the recheck's read is held");
    // ... then the real list (the item is open) brings the form back, and the operator sends again: try 2, dropped too.
    await page.unroute(`**${listPath}`);
    const listed = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname.endsWith(listPath));
    await nudge();
    await listed;
    const respond = panelOf(item).getByRole("button", { name: "Respond", exact: true });
    for (let i = 0; i < 50 && await respond.isDisabled(); i++) await new Promise((done) => setTimeout(done, 100));
    assert.equal(await respond.isDisabled(), false, "the open item's form is back");
    await respond.click();
    await panelOf(item).getByRole("alert").waitFor();
    await painted();
    // The old recheck's read now answers "closed": it must not touch try 2's failure.
    const closedBead = { ...show(item), status: "closed", close_reason: "Responded" };
    await held[0].fulfill({ json: closedBead });
    await new Promise((done) => setTimeout(done, 1000));
    await painted();
    assert.match(await panelOf(item).getByRole("alert").innerText(), /did not reach the board/, "try 2's failure stands");
    assert.notEqual(await panelOf(item).getByRole("alert").innerText(), CLOSED_NOW);
    // Try 3 reaches the board.
    await page.unroute(`**/beads/${item}/human`);
    await page.unroute(new RegExp(`/beads/${item}$`));
    await panelOf(item).getByRole("button", { name: "Respond", exact: true }).click();
    await toast(`Responded to ${item}`).waitFor();
    assert.equal(mine(item).length, 1);
    console.log("PASS answer speed: a recheck of an older try never changes a newer send's result");
  }

  // ---- The operator clicks on a stale card after a manager closed the item: refused, nothing written ----
  {
    const typed = "Ship it on Monday.";
    const item = create("A stale card?", null);
    const panel = await visit(item);
    await panel.getByRole("textbox", { name: "Write an answer" }).fill(typed);
    // The page keeps the list it has: every list request gets the one from before the close.
    const before = await (await page.request.get(`${base}${listPath}`)).json();
    await page.route(`**${listPath}`, (route) => route.fulfill({ json: before }));
    run(MANAGER, ["close", item, "--reason", "Responded"]); // a plain close, no comment
    await page.route(`**/beads/${item}/human`, async (route) => {
      await new Promise((done) => setTimeout(done, 1000));
      await route.continue();
    });
    await leaves(panel, () => panel.getByRole("button", { name: "Respond", exact: true }).click());
    await panelOf(item).getByRole("alert").waitFor();
    assert.match(await panelOf(item).getByRole("alert").innerText(), /no longer waiting for an answer/);
    assert.equal(await panelOf(item).getByRole("textbox", { name: "Write an answer" }).inputValue(), typed, "the typed text is back");
    assert.equal(mine(item).length, 0, "no late comment after someone else's close");
    assert.equal(show(item).close_reason, "Responded");
    // With a fresh list the card says the question was closed meanwhile.
    await page.unroute(`**${listPath}`);
    await page.unroute(`**/beads/${item}/human`);
    const listed = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname.endsWith(listPath));
    await refetch();
    await listed;
    await page.locator(`[data-closed-meanwhile="${item}"]`).getByRole("button", { name: "OK", exact: true }).click();
    await panelOf(item).waitFor({ state: "detached" });
    console.log("PASS answer speed: a click on a stale card after a manager's close is refused as stale, with nothing written");
  }

  // ---- The board's own bd is slower than the page's 30 s (re-check Minor 1, Minor 3) ----
  {
    const typed = "Ship it when it is ready.";
    const item = create("A slow board?", null);
    const panel = await visit(item);
    await panel.getByRole("textbox", { name: "Write an answer" }).fill(typed);
    slow("close", 45);
    await leaves(panel, () => panel.getByRole("button", { name: "Respond", exact: true }).click());
    // The page gives up after 30 s; the re-read waits behind the slow close and gives up too.
    await panelOf(item).getByRole("alert").waitFor({ timeout: 60000 });
    assert.equal(await panelOf(item).getByRole("alert").innerText(),
      "The board did not answer within 30 s; your answer may still be saved: check the item before answering again.");
    assert.equal(await panelOf(item).getByRole("textbox", { name: "Write an answer" }).inputValue(), typed);
    // The board finishes the write: the next list shows the item closed, the page reads it again
    // and takes the neutral words, with the typed text; it never counts the answer as sent.
    await page.waitForFunction(([id, words]) => document.querySelector(`[data-human-answer="${id}"] [role="alert"]`)?.textContent === words,
      [item, CLOSED_NOW], { timeout: 60000 });
    assert.equal(await panelOf(item).getByRole("textbox", { name: "Write an answer" }).inputValue(), typed);
    assert.equal(await toast(`Responded to ${item}`).count(), 0);
    await page.locator(`[data-closed-meanwhile="${item}"]`).getByRole("button", { name: "OK", exact: true }).click();
    await panelOf(item).waitFor({ state: "detached" });
    fast("close");
    assert.equal(show(item).close_reason, "Responded");
    assert.equal(mine(item).length, 1);
    console.log("PASS answer speed: a board slower than 30 s: the card comes back saying the answer may still be saved, then the neutral words when the item closes");
  }

  // ---- The detail drawer: the form gives way to "Sending your answer…" ----
  {
    const item = create("Answer from the drawer?");
    const panel = await visit(item, `bead=${item}`);
    slow("close", SLOW_S);
    const ms = await leaves(panel, () => panel.getByRole("group", { name: "Answer choices" }).getByRole("button", { name: /Use blue/ }).click());
    assert.ok(ms < 1000, `the drawer's form left ${ms} ms after the click`);
    await page.locator(`[data-answer-pending="${item}"]`).getByText("Sending your answer…").waitFor();
    await toast(`Responded to ${item}`).waitFor({ timeout: 30000 });
    fast("close");
    assert.equal(show(item).close_reason, "Responded");
    console.log("PASS answer speed: the drawer's form leaves at the click and says it is sending");
  }

  // ---- To Review: Accept and Reverse leave at the click; a failed Accept comes back ----
  {
    const row = (id) => page.locator(`[data-review-row="${id}"]`);
    const openReview = async (id) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await load("view=toreview");
        if (await row(id).count()) return row(id);
      }
      throw new Error(`the review row of ${id} did not show`);
    };
    const accepted = managerAnswered("Accept this answer?");
    let r = await openReview(accepted);
    slow("update", SLOW_S);
    let ms = await leaves(r, () => r.getByRole("button", { name: "Accept", exact: true }).click());
    assert.ok(ms < 1000, `the Accept row left ${ms} ms after the click`);
    await toast(`Accepted the answer to ${accepted}`).waitFor({ timeout: 30000 });
    fast("update");
    assert.equal(show(accepted).metadata["board.review"], "accepted");

    const refused = managerAnswered("Accept, but it fails?");
    r = await openReview(refused);
    refuse("update", refused);
    ms = await leaves(r, () => r.getByRole("button", { name: "Accept", exact: true }).click());
    assert.ok(ms < 1000, `the failing Accept row left ${ms} ms after the click`);
    await row(refused).getByRole("alert").waitFor();
    assert.match(await row(refused).getByRole("alert").innerText(), /The test refused this write\./);
    // Another action deals with the failure: the Reverse form never shows the Accept's error (review M2).
    await row(refused).getByRole("button", { name: "Reverse", exact: true }).click();
    await row(refused).locator(`[data-human-answer="${refused}"]`).waitFor();
    assert.equal(await row(refused).getByRole("alert").count(), 0, "the Accept's error is gone when Reverse opens");
    await row(refused).getByRole("button", { name: "Cancel", exact: true }).click();
    allow("update", refused);
    run("human:selden", ["update", refused, "--set-metadata", "board.review=accepted"]);

    const reversed = managerAnswered("Reverse this answer?");
    r = await openReview(reversed);
    await r.getByRole("button", { name: "Reverse", exact: true }).click();
    slow("close", SLOW_S);
    ms = await leaves(r, () => r.locator(`[data-human-answer="${reversed}"]`).getByRole("button", { name: /^Use green/ }).click());
    assert.ok(ms < 1000, `the Reverse row left ${ms} ms after the click`);
    await toast(`Reversed the answer to ${reversed}`).waitFor({ timeout: 30000 });
    fast("close");
    assert.equal(show(reversed).metadata["board.review"], "reversed");
    console.log("PASS answer speed: Accept and Reverse leave at the click; a failed Accept comes back with its error");
  }

  // ---- A page without crypto.randomUUID (plain HTTP): the answer still goes, never stuck in "Sending" (re-check rv-6mk-d) ----
  {
    const bare = await context.newPage();
    bare.on("pageerror", (error) => errors.push(error.message));
    await bare.addInitScript(() => { Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined, configurable: true }); });
    const item = create("No randomUUID?", null);
    const card = bare.locator(`[data-human-answer="${item}"]`);
    for (let attempt = 1; ; attempt++) {
      await bare.goto(`${base}/p/${project}?view=needsyou`);
      try {
        await card.getByRole("textbox", { name: "Write an answer" }).waitFor({ timeout: 8000 });
        break;
      } catch (e) {
        if (attempt === 4) throw e;
      }
    }
    assert.equal(await bare.evaluate(() => typeof crypto.randomUUID), "undefined");
    await card.getByRole("textbox", { name: "Write an answer" }).fill("Ship it anyway.");
    await card.getByRole("button", { name: "Respond", exact: true }).click();
    await card.waitFor({ state: "detached" });
    await bare.locator("[data-sonner-toast]").filter({ hasText: `Responded to ${item}` }).waitFor();
    assert.equal(show(item).close_reason, "Responded");
    assert.equal(mine(item).length, 1);
    await bare.close();
    console.log("PASS answer speed: without crypto.randomUUID the click id comes from getRandomValues; the answer goes");
  }

  await context.close();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  for (const command of ["close", "update"]) fast(command);
}
