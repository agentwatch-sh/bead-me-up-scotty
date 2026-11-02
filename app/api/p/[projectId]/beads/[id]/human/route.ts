import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { humanBodySchema, validateHumanAnswer } from "@/lib/human-validate";
import { ACKED_KEY, REVIEW_KEY, REVIEW_BY_KEY, REVIEW_REASON_KEY } from "@/lib/review";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; id: string }> };

/**
 * Act on a "Needs You" (human-labelled) bead. Matches `bd human` (upstream
 * issue #88; fork-only until that lands):
 *  - respond → post a comment answering the agent's question, then close the
 *    bead with reason "Responded". The `human` label stays as the record.
 *  - dismiss → close the bead with reason "Dismissed"; the label stays.
 * Closing a question that blocks a work bead unblocks that work bead.
 *
 * SCOTTY_HUMAN_RESPOND=keep-open restores the old behaviour: respond comments
 * and clears the `human` label; dismiss clears the label. Status is unchanged.
 *
 * An answer on an item that still holds a manager's review record (a Reverse
 * that failed half-way) removes the three review keys: the person answered.
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const body = humanBodySchema.parse(await req.json());
    const keepOpen = process.env.SCOTTY_HUMAN_RESPOND === "keep-open";

    const item = await store.get(id);
    const verdict = validateHumanAnswer(item, body, { closedOk: false });
    if (!verdict.ok) return ok({ error: verdict.error, code: verdict.code }, verdict.status);
    if (verdict.comment !== null) await store.addComment(id, verdict.comment, cfg.humanActor);
    const result = keepOpen && verdict.reason !== "Declined"
      ? await store.removeLabel(id, "human", cfg.humanActor)
      : await store.setStatus(id, "closed", cfg.humanActor, verdict.reason);
    if (!item?.metadata || item.metadata[REVIEW_KEY] === undefined) return ok(result);
    try {
      const cleanup: Record<string, null> = { [REVIEW_KEY]: null, [REVIEW_BY_KEY]: null, [REVIEW_REASON_KEY]: null };
      // A failed Reverse can leave board.acked on the open item, and agentwatch skips acked items.
      if (item.metadata[ACKED_KEY] !== undefined && item.metadata[ACKED_KEY] !== null) cleanup[ACKED_KEY] = null;
      return ok(await store.setMetadata(id, cleanup, cfg.humanActor));
    } catch (e) {
      console.error(`human: the review record of ${id} stays:`, e);
      return ok(result);
    }
  } catch (e) {
    return fail(e);
  }
}
