import { getStore } from "@/lib/store";
import { citeCheckUrl, getConfig, isReadOnly, lanePrefix, repoRefsUrl, viewerZoneUrl } from "@/lib/config";
import { createInputSchema } from "@/lib/schema";
import { ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const beads = await store.list();
    return ok({
      beads,
      meta: {
        kind: store.kind,
        humanActor: cfg.humanActor,
        humanAllowlist: cfg.humanAllowlist,
        pollIntervalMs: cfg.pollIntervalMs,
        gamification: cfg.gamification,
        orderStore: cfg.orderStore,
        readOnly: isReadOnly(_req),
        lanePrefix: lanePrefix(),
        repoRefsUrl: repoRefsUrl(projectId, store.kind),
        viewerZoneUrl: viewerZoneUrl(),
        // To Review's cite check (agentwatch age-29t6): without it, no cited answer shows as checked.
        citeCheckUrl: citeCheckUrl(projectId, store.kind),
        // The human route's mode (app/api/p/[projectId]/beads/[id]/human/route.ts): the
        // page reads only a closed item as an answer unless the board keeps items open.
        humanKeepOpen: process.env.SCOTTY_HUMAN_RESPOND === "keep-open",
      },
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const input = createInputSchema.parse(await req.json());
    const bead = await store.create(input, cfg.humanActor);
    return ok(bead, 201);
  } catch (e) {
    return fail(e);
  }
}
