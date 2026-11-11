import { z } from "zod";
import type { Bead } from "./schema";
import type { BeadsStore, SlotSteps } from "./store";
import { humanBodySchema, validateHumanAnswer } from "./human-validate";
import { ACKED_KEY, REVIEW_KEY, REVIEWED_BY_KEY, REVIEWED_AT_KEY, ReverseError, errorTag, needsReview, reverseAnswer, type ReverseStore } from "./review";
import { ANSWER_CLICK_KEY, clickIdOf, markedBy } from "./answer-click";

export const reviewBodySchema = z.discriminatedUnion("action", [
  // `click_id`: the id of the click (lib/answer-click.ts); a retry of the same click keeps it.
  z.object({ action: z.literal("accept"), click_id: z.string().max(64).optional() }),
  z.object({ action: z.literal("reverse"), answer: humanBodySchema, click_id: z.string().max(64).optional() }),
]);
export type ReviewBody = z.infer<typeof reviewBodySchema>;

export type ReviewResult =
  | { ok: true; bead: Bead; warning?: "review_record_failed" }
  | { ok: false; status: number; error: string; code: string; reviewRemoved?: boolean };

export interface ReviewOptions {
  /** The board user's actor; a client-sent actor is ignored. */
  actor: string;
  now: () => string;
  /** Where a failed Reverse is reported (the route's console.error). */
  log?: (line: string) => void;
}

/**
 * The store that `reverseAnswer` uses, made of the slot's steps: each write ends
 * with a read of the item, as the store's own methods do, so `reverseAnswer`
 * keeps its rules; all of it runs in the one slot.
 */
function slotStore(s: SlotSteps): ReverseStore {
  return {
    get: (id) => s.get(id),
    reopen: async (id, actor) => { await s.reopen(id, actor); return s.show(id); },
    addComment: async (id, text, actor) => { await s.addComment(id, text, actor); return s.show(id); },
    setMetadata: async (id, values, actor) => { await s.setMetadata(id, values, actor); return s.show(id); },
    setStatus: async (id, status, actor, reason) => {
      if (status !== "closed") throw new Error(`a review only closes, not ${status}`);
      await s.close(id, actor, reason);
      return s.show(id);
    },
  };
}

/**
 * Review an answer that a manager gave for the operator, in ONE slot of the
 * board's bd queue (agentwatch board age-6mk), as a Needs You answer is:
 *  - accept → the review record says `accepted`, by whom and when.
 *  - reverse → the operator's own answer replaces it: reopen, the operator's
 *    comment, close; the agent reads it as a new answer from the operator.
 * Only an item that `needsReview` can be reviewed.
 */
export async function answerReview(store: BeadsStore, id: string, body: ReviewBody, opts: ReviewOptions): Promise<ReviewResult> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const clickId = clickIdOf(body.click_id);
  return store.inOneSlot(async (s) => {
    // `bd show` leaves the comments out, and the latest answer decides.
    const found = await s.get(id);
    // This click already made the review (its response was lost): done, no write.
    const verdictKey = body.action === "accept" ? "accepted" : "reversed";
    if (found && markedBy(found.metadata, clickId) && found.metadata?.[REVIEW_KEY] === verdictKey) return { ok: true, bead: found };
    // The click's mark goes with the review record, never before it.
    const mark: Record<string, string> = clickId === null ? {} : { [ANSWER_CLICK_KEY]: clickId };
    const item = found ? { ...found, comments: await s.comments(id) } : null;
    if (!item || !needsReview(item, opts.actor)) {
      return { ok: false, status: 409, error: "This answer is not waiting for your review.", code: "not_pending" };
    }
    if (body.action === "accept") {
      await s.setMetadata(id, {
        [REVIEW_KEY]: "accepted",
        [REVIEWED_BY_KEY]: opts.actor,
        [REVIEWED_AT_KEY]: opts.now(),
        ...mark,
      }, opts.actor);
      return { ok: true, bead: await s.show(id) };
    }
    const verdict = validateHumanAnswer(item, body.answer, { closedOk: true });
    if (!verdict.ok) return { ok: false, status: verdict.status, error: verdict.error, code: verdict.code };
    if (verdict.comment === null) {
      return { ok: false, status: 400, error: "Pick an option or write an answer.", code: "answer_required" };
    }
    try {
      const acked = item.metadata?.[ACKED_KEY] !== undefined && item.metadata?.[ACKED_KEY] !== null;
      const { bead, warning } = await reverseAnswer(slotStore(s), id, verdict.comment, verdict.reason, opts.actor, acked, opts.now, mark);
      return warning ? { ok: true, bead, warning } : { ok: true, bead };
    } catch (e) {
      if (!(e instanceof ReverseError)) throw e;
      // The name and code of bd's error only: its message can hold the answer text.
      log(`review: ${e.code} on ${id}: ${errorTag(e.cause)}`);
      if (e.code === "reverse_not_started") {
        return { ok: false, status: 500, error: "The reverse did not start. Try again.", code: e.code };
      }
      return {
        ok: false,
        status: 500,
        error: "The reverse did not finish: the question is open again. Answer it in Needs You.",
        code: e.code,
        reviewRemoved: e.reviewRemoved,
      };
    }
  });
}
