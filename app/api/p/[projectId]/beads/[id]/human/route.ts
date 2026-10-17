import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; id: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("respond"), text: z.string().min(1) }),
  z.object({ action: z.literal("dismiss") }),
]);

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
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const body = bodySchema.parse(await req.json());
    const keepOpen = process.env.SCOTTY_HUMAN_RESPOND === "keep-open";

    if (body.action === "respond") await store.addComment(id, body.text, cfg.humanActor);
    if (keepOpen) return ok(await store.removeLabel(id, "human", cfg.humanActor));
    const reason = body.action === "respond" ? "Responded" : "Dismissed";
    return ok(await store.setStatus(id, "closed", cfg.humanActor, reason));
  } catch (e) {
    return fail(e);
  }
}
