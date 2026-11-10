import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { answerReview, reviewBodySchema } from "@/lib/review-answer";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; id: string }> };

const now = () => new Date().toISOString();

/**
 * Review an answer that a manager gave for the operator: accept, or reverse with
 * the operator's own answer. The rules, and the one queue slot the whole review
 * takes, are in lib/review-answer.ts. A client-sent actor is ignored.
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const body = reviewBodySchema.parse(await req.json());
    const result = await answerReview(store, id, body, { actor: cfg.humanActor, now });
    if (result.ok) return ok(result.warning ? { ...result.bead, warning: result.warning } : result.bead);
    const { status, error, code, reviewRemoved } = result;
    return ok(reviewRemoved === undefined ? { error, code } : { error, code, reviewRemoved }, status);
  } catch (e) {
    return fail(e);
  }
}
