import type { Bead } from "./schema";
import type { BeadsStore, SlotSteps } from "./store";
import { validateHumanAnswer, type HumanBody } from "./human-validate";
import { ACKED_KEY, REVIEW_KEY, REVIEW_BY_KEY, REVIEW_REASON_KEY, errorTag } from "./review";

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
  /** Where a kept review record or a failed close is reported (the route's console.error). */
  log?: (line: string) => void;
}

/**
 * Is `text` already the actor's newest comment on the item? Then an earlier try
 * of this answer saved it (its close failed, or its response was lost), and the
 * answer is not written a second time. `bd show` gives only the count of the
 * comments, so they are read only when the item has some.
 */
async function alreadySaved(s: SlotSteps, item: Bead, text: string, actor: string): Promise<boolean> {
  if (item.comment_count === 0) return false;
  const mine = (await s.comments(item.id)).filter((c) => c.author === actor);
  return mine.length > 0 && mine[mine.length - 1].text === text;
}

/**
 * Act on a "Needs You" (human-labelled) bead, in ONE slot of the board's bd
 * queue (agentwatch board age-6mk): read the item, write the comment, close,
 * read the item once for the response. No list export runs between the steps,
 * and no step reads the item again after the comment.
 *
 * The answer is written once: when the actor's newest comment on the item is
 * already this text (an earlier try saved it), only the close runs. When the
 * close fails after the answer is saved, the result says so
 * (`answer_saved_close_failed`), and a retry only closes.
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
  return store.inOneSlot(async (s) => {
    const item = await s.get(id);
    const verdict = validateHumanAnswer(item, body, { closedOk: false });
    if (!verdict.ok) return { ok: false, status: verdict.status, error: verdict.error, code: verdict.code };
    let saved = false;
    if (verdict.comment !== null && item) {
      if (!(await alreadySaved(s, item, verdict.comment, opts.actor))) await s.addComment(id, verdict.comment, opts.actor);
      saved = true;
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
