import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { humanBodySchema, validateHumanAnswer } from "@/lib/human-validate";
import { REVIEW_KEY, REVIEW_BY_KEY, REVIEW_REASON_KEY } from "@/lib/review";

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
    const result = keepOpen
      ? await store.removeLabel(id, "human", cfg.humanActor)
      : await store.setStatus(id, "closed", cfg.humanActor, verdict.reason);
    if (item?.metadata?.[REVIEW_KEY] === undefined) return ok(result);
    try {
      return ok(await store.setMetadata(id, { [REVIEW_KEY]: null, [REVIEW_BY_KEY]: null, [REVIEW_REASON_KEY]: null }, cfg.humanActor));
    } catch {
      return ok(result);
    }
  } catch (e) {
    return fail(e);
  }
}
