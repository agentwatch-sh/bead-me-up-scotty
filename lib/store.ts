import "server-only";
import type { Bead, Comment, CreateInput, UpdateInput, DepType } from "./schema";
import { getProject, touchProject, DEMO_PROJECT, ConfigError } from "./config";
import { createBdStore, isBdAvailable } from "./bd";
import { demoStore } from "./demo-store";

/**
 * Storage abstraction. Two implementations:
 *  - BdStore  → shells out to the `bd` CLI (source of truth).
 *  - DemoStore → in-memory, seeded from the design export, so the app runs and
 *    is demoable even where bd isn't installed.
 */
export interface DoctorInfo {
  kind: "bd" | "demo";
  ok: boolean;
  version?: string;
  repoPath: string;
  message: string;
}

/**
 * The steps of one write sequence, run back to back inside one slot of the
 * board's bd queue (see `inOneSlot`). Unlike the store's own methods, a write
 * step does not read the item again afterwards: the sequence calls `show` once,
 * when it needs the result.
 */
export interface SlotSteps {
  /** `bd show`; null when the item does not exist. */
  get(id: string): Promise<Bead | null>;
  show(id: string): Promise<Bead>;
  addComment(id: string, text: string, actor: string): Promise<void>;
  close(id: string, actor: string, reason?: string): Promise<void>;
  removeLabel(id: string, label: string, actor: string): Promise<void>;
  setMetadata(id: string, values: Record<string, string | number | null>, actor: string): Promise<void>;
}

export interface BeadsStore {
  kind: "bd" | "demo";
  /**
   * Run `steps` in ONE slot of the board's bd queue: no other bd call of this
   * board (a list's `bd export`, another write) runs between its steps, and a
   * call made meanwhile waits until the whole sequence is done (agentwatch
   * board age-6mk). Call only the given steps inside it: a store method called
   * there waits for this same slot and never runs.
   */
  inOneSlot<T>(steps: (s: SlotSteps) => Promise<T>): Promise<T>;
  list(): Promise<Bead[]>;
  get(id: string): Promise<Bead | null>;
  /** One item's comments (`bd comments ID`); `get` leaves them out. */
  comments(id: string): Promise<Comment[]>;
  create(input: CreateInput, actor: string): Promise<Bead>;
  update(id: string, patch: UpdateInput, actor: string): Promise<Bead>;
  /**
   * `reason` is only meaningful when closing — bd records it via
   * `bd close --reason`, and there is no way to attach one after the fact.
   */
  setStatus(id: string, status: string, actor: string, reason?: string): Promise<Bead>;
  /** Reopen a closed bead (`bd reopen`); clears closed_at and the close reason. */
  reopen(id: string, actor: string): Promise<Bead>;
  remove(id: string, actor: string): Promise<void>;
  addComment(id: string, text: string, actor: string): Promise<Bead>;
  addDep(id: string, dependsOnId: string, type: DepType, actor: string): Promise<Bead>;
  removeDep(id: string, dependsOnId: string, actor: string): Promise<Bead>;
  /** Create a human approval gate that blocks `blocks` (`bd gate create --type human`). */
  createGate(blocks: string, reason: string | undefined, actor: string): Promise<Bead>;
  /**
   * Set (or, with null, remove) bd metadata keys on one bead. Other keys are
   * left alone. Used to keep the manual board order in `scotty.rank`.
   */
  setMetadata(
    id: string,
    values: Record<string, string | number | null>,
    actor: string,
  ): Promise<Bead>;
  removeLabel(id: string, label: string, actor: string): Promise<Bead>;
  archive(id: string, actor: string): Promise<Bead>;
  doctor(): Promise<DoctorInfo>;
}

// One store per project id. Demo always maps to the shared in-memory store.
const stores = new Map<string, BeadsStore>();

export async function getStore(projectId: string): Promise<BeadsStore> {
  if (projectId === DEMO_PROJECT.id) return demoStore;

  const cached = stores.get(projectId);
  if (cached) return cached;

  const project = getProject(projectId);
  if (!project || project.path === null) {
    throw new ConfigError(`Unknown project: ${projectId}`, "unknown_project");
  }
  if (!(await isBdAvailable(project.path))) {
    throw new ConfigError(
      `bd is not available for "${project.name}" (${project.path}). ` +
        `Check that bd is installed and the folder still contains a .beads directory.`,
      "bd_unavailable",
    );
  }
  const store = createBdStore(project.path);
  stores.set(projectId, store);
  // First resolution this session — record that the project was opened.
  touchProject(projectId);
  return store;
}

/** Reset cached store(s) — one project, or all when no id is given. */
export function resetStore(projectId?: string) {
  if (projectId) stores.delete(projectId);
  else stores.clear();
}
