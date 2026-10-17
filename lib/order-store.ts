import "server-only";
import type { Bead } from "./schema";
import type { BeadsStore } from "./store";
import { colOf } from "./board-columns";
import {
  getConfig,
  getColumnOrders as getLocalOrders,
  setColumnOrder as setLocalOrder,
  markOrderMigrated,
} from "./config";

/**
 * Where the manual board order lives. The "local" backend is the app-local
 * config.json (lib/config.ts). The "beads" backend writes each bead's position
 * into its `scotty.rank` metadata, so agents reading `bd list --json` see the
 * order a person set. Chosen by the `orderStore` setting.
 */
export const RANK_KEY = "scotty.rank";
/** Gap between neighbouring ranks, so a reader can slot a bead in between. */
export const RANK_STEP = 1024;

function rankOf(bead: Bead): number | null {
  const v = bead.metadata?.[RANK_KEY];
  // Accept a numeric string too, in case bd ever returns metadata values as text.
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// A reorder reads the beads, diffs the ranks, then writes the changes. Two of
// those overlapping would interleave their writes, so each project's whole
// read -> diff -> write sequence (and the migration) runs one at a time.
const chains = new Map<string, Promise<unknown>>();
function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  chains.set(projectId, tail);
  void tail.then(() => {
    if (chains.get(projectId) === tail) chains.delete(projectId);
  });
  return next;
}

/** Each column's ranked beads, lowest rank first. Unranked beads are left out. */
function deriveOrders(beads: Bead[]): Record<string, string[]> {
  const index = new Map(beads.map((b) => [b.id, b]));
  const byColumn = new Map<string, { id: string; rank: number }[]>();
  for (const bead of beads) {
    const rank = rankOf(bead);
    if (rank === null) continue;
    const col = colOf(bead, index);
    if (!col) continue;
    byColumn.set(col, [...(byColumn.get(col) ?? []), { id: bead.id, rank }]);
  }
  const orders: Record<string, string[]> = {};
  for (const [col, items] of byColumn) {
    items.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
    orders[col] = items.map((i) => i.id);
  }
  return orders;
}

/** Write position × RANK_STEP for each id, touching only beads whose rank changes. */
async function writeRanks(store: BeadsStore, beads: Bead[], ids: string[], actor: string) {
  const byId = new Map(beads.map((b) => [b.id, b]));
  for (let i = 0; i < ids.length; i++) {
    const bead = byId.get(ids[i]);
    if (!bead) continue;
    const rank = i * RANK_STEP;
    if (rankOf(bead) === rank) continue;
    await store.setMetadata(bead.id, { [RANK_KEY]: rank }, actor);
  }
}

/** Copy a project's saved local order into beads metadata, once. Call with the project lock held. */
async function migrateLocal(projectId: string, store: BeadsStore, actor: string) {
  if (getConfig().ordersMigrated?.includes(projectId)) return;
  const local = getLocalOrders(projectId);
  if (Object.keys(local).length) {
    const beads = await store.list();
    for (const ids of Object.values(local)) await writeRanks(store, beads, ids, actor);
  }
  markOrderMigrated(projectId);
}

/**
 * Switching local → beads: copy every project's saved order across. Best effort
 * per project; one that cannot be reached migrates on its next order request.
 */
export async function migrateAllLocalOrders(
  projects: { id: string; store: () => Promise<BeadsStore> }[],
  actor: string,
) {
  for (const p of projects) {
    try {
      const store = await p.store();
      await withProjectLock(p.id, () => migrateLocal(p.id, store, actor));
    } catch {
      /* migrates lazily on the next order request */
    }
  }
}

/**
 * Column orders for a project. `writable` is false in read-only mode, where a
 * pending migration is skipped and the saved local order shows instead.
 */
export async function getColumnOrders(
  projectId: string,
  openStore: () => Promise<BeadsStore>,
  actor: string,
  writable = true,
): Promise<Record<string, string[]>> {
  // The local backend never reads beads, so it needs no store (or bd) at all.
  if (getConfig().orderStore !== "beads") return getLocalOrders(projectId);
  const store = await openStore();
  return withProjectLock(projectId, async () => {
    const pending = !getConfig().ordersMigrated?.includes(projectId);
    if (pending && writable) await migrateLocal(projectId, store, actor);
    const derived = deriveOrders(await store.list());
    return pending && !getConfig().ordersMigrated?.includes(projectId)
      ? { ...getLocalOrders(projectId), ...derived }
      : derived;
  });
}

/** Replace one column's order, then return all of the project's column orders. */
export async function setColumnOrder(
  projectId: string,
  columnId: string,
  ids: string[],
  openStore: () => Promise<BeadsStore>,
  actor: string,
): Promise<Record<string, string[]>> {
  if (getConfig().orderStore !== "beads") return setLocalOrder(projectId, columnId, ids);
  const store = await openStore();
  return withProjectLock(projectId, async () => {
    await migrateLocal(projectId, store, actor);
    // Read the beads only now that the lock is held, so the diff is current.
    await writeRanks(store, await store.list(), ids, actor);
    return deriveOrders(await store.list());
  });
}
