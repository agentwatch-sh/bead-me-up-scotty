import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { humanBodySchema, validateHumanAnswer } from "@/lib/human-validate";
import { ACKED_KEY, REVIEW_KEY, REVIEWED_BY_KEY, REVIEWED_AT_KEY, ReverseError, needsReview, reverseAnswer } from "@/lib/review";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; id: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("reverse"), answer: humanBodySchema }),
]);

const now = () => new Date().toISOString();

/**
 * Review an answer that a manager gave for the operator.
 *  - accept → the review record says `accepted`, by whom and when.
 *  - reverse → the operator's own answer replaces it: reopen, the operator's
 *    comment, close; the agent reads it as a new answer from the operator.
 * Only an item that `needsReview` can be reviewed. A client-sent actor is ignored.
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const body = bodySchema.parse(await req.json());

    // `bd show` leaves the comments out, and the latest answer decides, so read the list.
    const item = (await store.list()).find((b) => b.id === id) ?? null;
    if (!item || !needsReview(item)) {
      return ok({ error: "This answer is not waiting for your review.", code: "not_pending" }, 409);
    }
    if (body.action === "accept") {
      return ok(await store.setMetadata(id, {
        [REVIEW_KEY]: "accepted",
        [REVIEWED_BY_KEY]: cfg.humanActor,
        [REVIEWED_AT_KEY]: now(),
      }, cfg.humanActor));
    }
    const verdict = validateHumanAnswer(item, body.answer, { closedOk: true });
    if (!verdict.ok) return ok({ error: verdict.error, code: verdict.code }, verdict.status);
    if (verdict.comment === null) {
      return ok({ error: "Pick an option or write an answer.", code: "answer_required" }, 400);
    }
    try {
      const acked = item.metadata?.[ACKED_KEY] !== undefined && item.metadata?.[ACKED_KEY] !== null;
      const { bead, warning } = await reverseAnswer(store, id, verdict.comment, verdict.reason, cfg.humanActor, acked, now);
      return ok(warning ? { ...bead, warning } : bead);
    } catch (e) {
      if (e instanceof ReverseError && e.code === "reverse_not_started") {
        return ok({ error: "The reverse did not start. Try again.", code: e.code }, 500);
      }
      if (e instanceof ReverseError) {
        return ok({
          error: "The reverse did not finish: the question is open again. Answer it in Needs You.",
          code: e.code,
          reviewRemoved: e.reviewRemoved,
        }, 500);
      }
      throw e;
    }
  } catch (e) {
    return fail(e);
  }
}
