import type { Bead } from "./schema";
import type { BeadsStore } from "./store";
import { validateHumanAnswer, type HumanBody } from "./human-validate";
import { ACKED_KEY, REVIEW_KEY, REVIEW_BY_KEY, REVIEW_REASON_KEY, errorTag } from "./review";
import { ANSWER_CLICK_KEY, clickIdOf, markedBy } from "./answer-click";

export type HumanAnswerResult =
  | { ok: true; bead: Bead }
  | { ok: false; status: number; error: string; code: string };

/** The answer's comment is on the item, but its close failed: a retry only closes. */
export const ANSWER_SAVED_CLOSE_FAILED = "answer_saved_close_failed";
const SAVED_CLOSE_FAILED_TEXT = "Your answer is saved; closing failed: try again.";

export interface HumanAnswerOptions {
  /** The board user's actor (`human:<user>`); a client-sent actor is never used. */
  actor: string;
  /** SCOTTY_HUMAN_RESPOND=keep-open: respond and dismiss clear the label instead of closing. */
  keepOpen: boolean;
  /** Where a kept review record, a lost mark or a failed close is reported (the route's console.error). */
  log?: (line: string) => void;
}

/** Is the item done: closed, or (keep-open) open without the `human` label? */
const done = (item: Bead, keepOpen: boolean) => item.status === "closed" || (keepOpen && !item.labels.includes("human"));

/**
 * Act on a "Needs You" (human-labelled) bead, in ONE slot of the board's bd
 * queue (agentwatch board age-6mk): read the item, write the comment, mark the
 * item with the click's id, close, read the item once for the response. No list
 * export runs between the steps.
 *
 * An answer is written once per click (lib/answer-click.ts). The page sends the
 * id of the click (`click_id`); a retry of the same click sends the same id.
 *  - The item is done and carries this click's mark: an earlier try finished
 *    it; a success with no write (never when a manager's answer waits for review).
 *  - The item carries this click's mark but is still open: an earlier try saved
 *    the comment; only the close runs.
 *  - Otherwise the comment is written, then the mark, then the close.
 * Without a click id (an older page) the answer is written as before, with no mark.
 * Known limit: when the comment is written and the mark then fails, a retry
 * writes the comment again (two bd calls cannot be one); the answer itself goes on.
 * A close that fails after the answer is saved says so (`answer_saved_close_failed`).
 *
 * Matches `bd human` (upstream issue #88; fork-only until that lands):
 *  - respond → the comment answering the agent's question, then close with
 *    reason "Responded". The `human` label stays as the record.
 *  - dismiss → close with reason "Dismissed"; the label stays.
 *  - decline → the reason as a canonical comment, then close as "Declined".
 * keepOpen (SCOTTY_HUMAN_RESPOND=keep-open) restores the old behaviour: respond
 * and dismiss clear the `human` label and leave the status alone.
 *
 * An answer on an item that still holds a manager's review record (a Reverse
 * that failed half-way) removes the three review keys: the person answered.
 */
export async function answerHuman(store: BeadsStore, id: string, body: HumanBody, opts: HumanAnswerOptions): Promise<HumanAnswerResult> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const clickId = clickIdOf(body.click_id);
  return store.inOneSlot(async (s) => {
    const item = await s.get(id);
    // This click already finished the item (its response was lost): done, no write.
    if (item && markedBy(item.metadata, clickId) && done(item, opts.keepOpen) && item.metadata?.[REVIEW_KEY] !== "pending") {
      return { ok: true, bead: item };
    }
    const verdict = validateHumanAnswer(item, body, { closedOk: false });
    if (!verdict.ok) return { ok: false, status: verdict.status, error: verdict.error, code: verdict.code };
    let saved = false;
    if (verdict.comment !== null && item) {
      // An earlier try of this click saved the comment (its mark is on the item): not again.
      if (!markedBy(item.metadata, clickId)) await s.addComment(id, verdict.comment, opts.actor);
      saved = true;
    }
    if (clickId !== null && !markedBy(item?.metadata, clickId)) {
      try {
        await s.setMetadata(id, { [ANSWER_CLICK_KEY]: clickId }, opts.actor);
      } catch (e) {
        // The answer goes on without its mark (the known limit above).
        log(`human: the click mark of ${id} was not written: ${errorTag(e)}`);
      }
    }
    try {
      if (opts.keepOpen && verdict.reason !== "Declined") await s.removeLabel(id, "human", opts.actor);
      else await s.close(id, opts.actor, verdict.reason);
    } catch (e) {
      if (!saved) throw e;
      log(`human: the close of ${id} failed after its answer was saved: ${errorTag(e)}`);
      return { ok: false, status: 500, error: SAVED_CLOSE_FAILED_TEXT, code: ANSWER_SAVED_CLOSE_FAILED };
    }
    if (item?.metadata && item.metadata[REVIEW_KEY] !== undefined) {
      const cleanup: Record<string, null> = { [REVIEW_KEY]: null, [REVIEW_BY_KEY]: null, [REVIEW_REASON_KEY]: null };
      // A failed Reverse can leave board.acked on the open item, and agentwatch skips acked items.
      if (item.metadata[ACKED_KEY] !== undefined && item.metadata[ACKED_KEY] !== null) cleanup[ACKED_KEY] = null;
      try {
        await s.setMetadata(id, cleanup, opts.actor);
      } catch (e) {
        log(`human: the review record of ${id} stays: ${errorTag(e)}`);
      }
    }
    return { ok: true, bead: await s.show(id) };
  });
}
