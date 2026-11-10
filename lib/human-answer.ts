import type { Bead } from "./schema";
import type { BeadsStore } from "./store";
import { validateHumanAnswer, type HumanBody } from "./human-validate";
import { ACKED_KEY, REVIEW_KEY, REVIEW_BY_KEY, REVIEW_REASON_KEY, errorTag } from "./review";

export type HumanAnswerResult =
  | { ok: true; bead: Bead }
  | { ok: false; status: number; error: string; code: string };

export interface HumanAnswerOptions {
  /** The board user's actor (`human:<user>`); a client-sent actor is never used. */
  actor: string;
  /** SCOTTY_HUMAN_RESPOND=keep-open: respond and dismiss clear the label instead of closing. */
  keepOpen: boolean;
  /** Where a kept review record is reported (the route's console.error). */
  log?: (line: string) => void;
}

/**
 * Act on a "Needs You" (human-labelled) bead, in ONE slot of the board's bd
 * queue (agentwatch board age-6mk): read the item, write the comment, close,
 * read the item once for the response. No list export runs between the steps,
 * and no step reads the item again after the comment.
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
    if (verdict.comment !== null) await s.addComment(id, verdict.comment, opts.actor);
    if (opts.keepOpen && verdict.reason !== "Declined") await s.removeLabel(id, "human", opts.actor);
    else await s.close(id, opts.actor, verdict.reason);
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
