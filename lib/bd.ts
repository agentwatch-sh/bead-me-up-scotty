import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  beadSchema,
  commentSchema,
  unwrapEnvelope,
  type Bead,
  type CreateInput,
  type UpdateInput,
  type DepType,
} from "./schema";
import type { BeadsStore, DoctorInfo, SlotSteps } from "./store";

const pExecFile = promisify(execFile);
const BD_BIN = process.env.BD_BIN || "bd";
/**
 * The longest one bd call may run (agentwatch board age-6mk). bd waits for the
 * Dolt lock instead of failing, and a write sequence holds the board's queue
 * slot across several calls: without a limit, one hung call would hold every
 * list and write of the board. SCOTTY_BD_TIMEOUT_MS overrides the 60 s.
 *
 * The limit stops the process that BD_BIN names, and only that one: execFile's
 * timeout signals its own child, and execFile does not pass `detached` to spawn,
 * so bd cannot get a process group of its own here. When BD_BIN is a wrapper (a
 * shell script that runs the real bd as its child, as scripts/slow-bd.sh does in
 * the UI test), the real bd under it keeps running after the limit and can still
 * write; the slot is released either way. agentwatch sets BD_BIN to the real bd.
 * A group stop needs a spawn-based runner (re-check rv-6mk-b, Minor 4).
 */
const BD_TIMEOUT_MS = Number(process.env.SCOTTY_BD_TIMEOUT_MS) > 0 ? Number(process.env.SCOTTY_BD_TIMEOUT_MS) : 60_000;

export class BdError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BdError";
    this.code = code;
  }
}

/**
 * Run a bd command. Args are passed as an array (no shell) so titles and
 * descriptions are injection-safe. Always requests the JSON envelope.
 */
async function runBdRaw(
  args: string[],
  opts: { repoPath: string; actor?: string },
): Promise<string> {
  try {
    const { stdout } = await pExecFile(BD_BIN, args, {
      cwd: opts.repoPath,
      maxBuffer: 32 * 1024 * 1024,
      timeout: BD_TIMEOUT_MS,
      env: {
        ...process.env,
        BD_JSON_ENVELOPE: "1",
        ...(opts.actor ? { BEADS_ACTOR: opts.actor } : {}),
      },
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    // The time limit killed bd. The message names the command only: the error's
    // own message quotes the argv, which can hold the operator's answer text.
    if (e.killed) throw new BdError(`bd ${args[0]} did not finish within ${BD_TIMEOUT_MS / 1000} s`, "bd_timeout");
    // bd emits a JSON error object to stderr with a `code` when --json is active.
    const stderr = (e.stderr || "").trim();
    try {
      const parsed = JSON.parse(stderr) as { error?: string; code?: string };
      if (parsed.error) throw new BdError(parsed.error, parsed.code);
    } catch (parseErr) {
      if (parseErr instanceof BdError) throw parseErr;
    }
    // bd emits the pending-migration block as PLAIN-TEXT stderr, not the JSON
    // envelope, so it would otherwise fall through uncoded and dump ~200 words
    // of raw text into a toast. Tag it here so the UI keys off a stable code
    // rather than string-matching in React. (gastownhall/beads#4259)
    if (/pending schema migration|BD_ALLOW_REMOTE_MIGRATE|#4259/i.test(stderr)) {
      throw new BdError(stderr, "schema_migration_required");
    }
    throw new BdError(stderr || e.message || "bd command failed");
  }
}

async function runBdJson<T = unknown>(
  args: string[],
  opts: { repoPath: string; actor?: string },
): Promise<T> {
  const out = await runBdRaw([...args, "--json"], opts);
  return unwrapEnvelope(JSON.parse(out)) as T;
}

/** Parse `bd export --json` JSONL output into validated beads. */
function parseExport(jsonl: string): Bead[] {
  const beads: Bead[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = beadSchema.safeParse(obj);
    // Skip memory/non-issue records (they lack required issue fields).
    if (parsed.success && parsed.data.issue_type) beads.push(parsed.data);
  }
  return beads;
}

// ---- bd serialization (embedded Dolt is single-writer *per database*) ----
// EVERY bd invocation — including read-only `export`/`show` — rewrites the
// embedded-Dolt store, so reads MUST serialize with writes too. Running them
// concurrently corrupts persists ("Unable to write SST file …") and collides on
// compaction ("Another write batch or compaction is already active").
// Keyed by repoPath so same-project bd calls serialize while different projects
// run in parallel.
const writeChains = new Map<string, Promise<unknown>>();
function serializeWrite<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(
    repoPath,
    next.catch(() => {}),
  );
  return next;
}

const availabilityCache = new Map<string, boolean>();

export async function isBdAvailable(repoPath: string): Promise<boolean> {
  const hit = availabilityCache.get(repoPath);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    await pExecFile(BD_BIN, ["--version"], { timeout: 5000 });
    ok = fs.existsSync(path.join(repoPath, ".beads"));
  } catch {
    ok = false;
  }
  availabilityCache.set(repoPath, ok);
  return ok;
}

export function createBdStore(repoPath: string): BeadsStore {
  const ro = { repoPath };
  const rw = (actor: string) => ({ repoPath, actor });
  // Collapse concurrent list() callers (the polling views) onto one in-flight export.
  let inflightList: Promise<Bead[]> | null = null;

  async function show(id: string): Promise<Bead> {
    // bd 1.0.5 `show <id> --json` returns its envelope `data` as an ARRAY even
    // for a single id, while beadSchema expects one object. Unwrap before parse.
    const data = await runBdJson(["show", id], ro);
    const rec = Array.isArray(data) ? data[0] : data;
    if (!rec) throw new BdError(`bead ${id} not found`, "not_found");
    const parsed = beadSchema.safeParse(rec);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new BdError(`could not parse bead ${id}: ${detail}`, "parse_error");
    }
    return parsed.data;
  }

  // The writes, each built once. They run inside a slot of the queue: the
  // store's methods below and `inOneSlot` take the slot around them.
  const steps: SlotSteps = {
    async get(id) {
      try {
        return await show(id);
      } catch (e) {
        if (e instanceof BdError && e.code === "not_found") return null;
        throw e;
      }
    },
    show,
    async comments(id) {
      const data = await runBdJson(["comments", id], ro);
      return commentSchema.array().parse(Array.isArray(data) ? data : []);
    },
    async reopen(id, actor) {
      await runBdRaw(["reopen", id], rw(actor));
    },
    async addComment(id, text, actor) {
      // "--" ends the flags: a comment such as "--file=PATH" or "--actor=X"
      // is text, not a flag. bd keeps the text after it as it is.
      await runBdRaw(["comment", id, "--", text], rw(actor));
    },
    async close(id, actor, reason) {
      const args = ["close", id];
      // Only `bd close --reason` persists a close reason, and re-closing an
      // already-closed bead won't overwrite it — so this is the one chance
      // to record why. Args go through execFile, so prose is safe verbatim.
      const trimmed = reason?.trim();
      if (trimmed) args.push("--reason", trimmed);
      await runBdRaw(args, rw(actor));
    },
    async removeLabel(id, label, actor) {
      await runBdRaw(["update", id, "--remove-label", label], rw(actor));
    },
    async setMetadata(id, values, actor) {
      const args = ["update", id];
      for (const [key, value] of Object.entries(values)) {
        if (value === null) args.push("--unset-metadata", key);
        else args.push("--set-metadata", `${key}=${value}`);
      }
      if (args.length > 2) await runBdRaw(args, rw(actor));
    },
  };

  return {
    kind: "bd",

    inOneSlot(fn) {
      return serializeWrite(repoPath, () => fn(steps));
    },

    async list() {
      // Dedupe concurrent callers onto one in-flight export, and serialize that
      // export with all other bd ops so reads can't collide with writes/compaction.
      if (inflightList) return inflightList;
      inflightList = serializeWrite(repoPath, async () =>
        parseExport(await runBdRaw(["export", "--json"], ro)),
      );
      try {
        return await inflightList;
      } finally {
        inflightList = null;
      }
    },

    async get(id) {
      // Serialized too — `bd show` rewrites the store like any other invocation.
      return serializeWrite(repoPath, () => steps.get(id));
    },

    comments(id) {
      return serializeWrite(repoPath, () => steps.comments(id));
    },

    create(input: CreateInput, actor: string) {
      return serializeWrite(repoPath, async () => {
        // The title is the value of --title=, never a positional argument: bd
        // reads a flag anywhere in argv, so a title such as "--file=PATH"
        // would be a flag. bd 1.3.1 refuses a positional title that starts
        // with "-" even after "--", and takes any text as --title=<text>.
        const args = [
          "create",
          `--title=${input.title}`,
          "-t",
          input.issue_type,
          "--priority",
          String(input.priority),
        ];
        if (input.description) args.push("--description", input.description);
        if (input.assignee) args.push("--assignee", input.assignee);
        if (input.labels?.length) args.push("-l", input.labels.join(","));
        if (input.parent) args.push("--parent", input.parent);
        const created = await runBdJson<{ id: string }>(args, rw(actor));
        const id = created.id;
        if (input.backlog) {
          await runBdRaw(["update", id, "-s", "deferred"], rw(actor));
        }
        return show(id);
      });
    },

    update(id, patch: UpdateInput, actor: string) {
      return serializeWrite(repoPath, async () => {
        const args = ["update", id];
        if (patch.title !== undefined) args.push("--title", patch.title);
        if (patch.description !== undefined) args.push("--description", patch.description);
        if (patch.status !== undefined) args.push("-s", patch.status);
        if (patch.priority !== undefined) args.push("--priority", String(patch.priority));
        if (patch.issue_type !== undefined) args.push("-t", patch.issue_type);
        if (patch.assignee !== undefined) args.push("--assignee", patch.assignee);
        // `!== undefined` rather than a truthiness check: `""` is the detach
        // signal, so `if (patch.parent)` would make detaching inexpressible.
        if (patch.parent !== undefined) args.push("--parent", patch.parent);
        // Labels are replace-all. `bd update --set-labels ""` is silently
        // dropped (verified against bd 1.1.0) — an empty value never clears —
        // so the "remove every label" case has to go through --remove-label
        // with the bead's current labels instead.
        if (patch.labels !== undefined) {
          if (patch.labels.length) {
            args.push("--set-labels", patch.labels.join(","));
          } else {
            const current = (await show(id)).labels ?? [];
            if (current.length) args.push("--remove-label", current.join(","));
          }
        }
        // `bd update <id>` with no field flags is a no-op error; skip the call
        // when clearing labels on a bead that had none.
        if (args.length > 2) await runBdRaw(args, rw(actor));
        return show(id);
      });
    },

    setStatus(id, status, actor, reason) {
      return serializeWrite(repoPath, async () => {
        if (status === "closed") {
          await steps.close(id, actor, reason);
        } else {
          await runBdRaw(["update", id, "-s", status], rw(actor));
        }
        return show(id);
      });
    },

    reopen(id, actor) {
      return serializeWrite(repoPath, async () => {
        await steps.reopen(id, actor);
        return show(id);
      });
    },

    remove(id, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["delete", id, "--force"], rw(actor));
      });
    },

    addComment(id, text, actor) {
      return serializeWrite(repoPath, async () => {
        await steps.addComment(id, text, actor);
        return show(id);
      });
    },

    addDep(id, dependsOnId, type: DepType, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["dep", "add", id, dependsOnId, "-t", type], rw(actor));
        return show(id);
      });
    },

    removeDep(id, dependsOnId, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["dep", "remove", id, dependsOnId], rw(actor));
        return show(id);
      });
    },

    createGate(blocks, reason, actor) {
      return serializeWrite(repoPath, async () => {
        const args = ["gate", "create", "--type", "human", "--blocks", blocks];
        if (reason) args.push("--reason", reason);
        // `bd gate create --json` returns the created gate object (incl. its id).
        const created = await runBdJson<{ id: string }>(args, rw(actor));
        return show(created.id);
      });
    },

    setMetadata(id, values, actor) {
      return serializeWrite(repoPath, async () => {
        await steps.setMetadata(id, values, actor);
        return show(id);
      });
    },

    removeLabel(id, label, actor) {
      return serializeWrite(repoPath, async () => {
        await steps.removeLabel(id, label, actor);
        return show(id);
      });
    },

    archive(id, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["close", id], rw(actor));
        await runBdRaw(["label", "add", id, "archived"], rw(actor));
        return show(id);
      });
    },

    async doctor(): Promise<DoctorInfo> {
      try {
        const { stdout } = await pExecFile(BD_BIN, ["--version"], { cwd: repoPath, timeout: 5000 });
        return {
          kind: "bd",
          ok: true,
          version: stdout.trim(),
          repoPath,
          message: `Connected to bd at ${repoPath}`,
        };
      } catch (e) {
        return {
          kind: "bd",
          ok: false,
          repoPath,
          message: (e as Error).message,
        };
      }
    },
  };
}
