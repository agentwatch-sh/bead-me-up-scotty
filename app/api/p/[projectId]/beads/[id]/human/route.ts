import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { humanBodySchema } from "@/lib/human-validate";
import { answerHuman } from "@/lib/human-answer";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; id: string }> };

/**
 * Act on a "Needs You" (human-labelled) bead: respond, dismiss or decline. The
 * rules, and the one queue slot the whole answer takes, are in lib/human-answer.ts.
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const body = humanBodySchema.parse(await req.json());
    const keepOpen = process.env.SCOTTY_HUMAN_RESPOND === "keep-open";
    const result = await answerHuman(store, id, body, { actor: cfg.humanActor, keepOpen });
    return result.ok ? ok(result.bead) : ok({ error: result.error, code: result.code }, result.status);
  } catch (e) {
    return fail(e);
  }
}
