import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { addCommentSchema } from "@/lib/schema";
import { ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ projectId: string; id: string }> }) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const { text } = addCommentSchema.parse(await req.json());
    const bead = await store.addComment(id, text, cfg.humanActor);
    return ok(bead);
  } catch (e) {
    return fail(e);
  }
}

/**
 * One item's comments (`bd comments ID`; the list and `bd show` give only their
 * count). The page reads them after an answer whose request failed, to tell
 * whether this answer landed (agentwatch board age-6mk).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string; id: string }> }) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    return ok(await store.comments(id));
  } catch (e) {
    return fail(e);
  }
}
