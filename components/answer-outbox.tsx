"use client";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useApp } from "@/components/app-context";
import { needsHuman } from "@/lib/beads-view";
import { toastError } from "@/components/error-toast";
import { beadsKey } from "@/hooks/use-beads";
import { api, type BeadsResponse } from "@/lib/api-client";
import type { HumanBody } from "@/lib/human-validate";
import type { Bead, Comment } from "@/lib/schema";
import {
  ANSWER_TIMEOUT_MS, answerLanded, clickFor, failureText, isHidden, mayHaveLanded, needsRecheck, outboxAfter, outboxKey, outboxText,
  patchAnswered, settledOnBoard, type Outbox, type OutboxEntry, type OutboxEvent, type OutboxKind, type SentAnswer,
} from "@/lib/answer-outbox";

/** Where an answer goes instead of the human route (To Review sends a Reverse). */
export interface AnswerRoute {
  kind: OutboxKind;
  request: (body: HumanBody, signal: AbortSignal) => Promise<unknown>;
  /** A 2xx that still needs the operator: a warning instead of the confirmation. */
  warning?: (body: unknown) => string | null;
}

export interface OutboxSend {
  id: string;
  kind: OutboxKind;
  /**
   * The write. It gets up to ANSWER_TIMEOUT_MS, and the click time (ms): a retry
   * of the same answer keeps its first click, so the board writes it once.
   * Its 2xx body (the item) patches the list at once.
   */
  request: (signal: AbortSignal, clickedAt: number) => Promise<unknown>;
  /** The same answer has the same fingerprint (its request body). */
  fingerprint: string;
  /** The comment the answer writes, or null: a re-read checks it is the actor's. */
  comment: string | null;
  /** What the form held; it comes back with the item when the write fails. */
  draft?: unknown;
  /** A 2xx that still needs the operator: a warning instead of the confirmation. */
  warning?: (body: unknown) => string | null;
}

interface OutboxApi {
  /** Is the item out of its list (its write runs, or an older list is on screen)? */
  hidden: (id: string) => boolean;
  entry: (id: string) => OutboxEntry | undefined;
  /** Send one answer: the item leaves at once; true when the board took it. */
  send: (item: OutboxSend) => Promise<boolean>;
  /** Send several, one after the other, all out of the list at once (Accept all).
   *  The first failure stops the rest, which come back as they were. */
  sendInOrder: (items: OutboxSend[]) => Promise<boolean>;
  /** The operator dealt with a failure (edited the form, started another action): its error goes. */
  clear: (id: string) => void;
}

const OutboxContext = React.createContext<OutboxApi | null>(null);

/** How long the page waits for the item's state after a failure that may have been written. */
const REREAD_TIMEOUT_MS = 10_000;

/**
 * The operator's answers on their way to the board (agentwatch board age-6mk).
 * It lives above the views, so an item's card can unmount at the click while its
 * write runs on. `listStartedAt` is when the list on screen was requested.
 * Entries are kept per project (`outboxKey`): an answer in one board never hides
 * or restores an item with the same id in another.
 */
export function AnswerOutboxProvider({ projectId, listStartedAt, children }: {
  projectId: string;
  listStartedAt: number | undefined;
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const { beads, meta } = useApp();
  const actor = meta?.humanActor ?? "";
  const [box, setBox] = React.useState<Outbox>({});
  const apply = React.useCallback((event: OutboxEvent) => setBox((previous) => outboxAfter(previous, event)), []);
  // Per item: the last answer sent (for a retry's click time and for a later check).
  const attempts = React.useRef(new Map<string, { item: OutboxSend; sent: SentAnswer }>());
  const rechecking = React.useRef(new Set<string>());

  /** The item and, for a comment answer, its comments, read again; null when it cannot be read. */
  const reread = React.useCallback(async (item: OutboxSend): Promise<{ bead: Bead; comments: Comment[] } | null> => {
    try {
      const signal = AbortSignal.timeout(REREAD_TIMEOUT_MS);
      const [bead, comments] = await Promise.all([
        api.get(projectId, item.id, signal),
        item.comment !== null ? api.comments(projectId, item.id, signal) : Promise.resolve([] as Comment[]),
      ]);
      return { bead, comments };
    } catch {
      return null;
    }
  }, [projectId]);

  const confirm = React.useCallback((key: string, item: OutboxSend, body: unknown) => {
    const text = outboxText(item.kind, item.id);
    // The board's word on the item, before any list: an older list never brings it back.
    apply({ type: "sent", id: key, at: Date.now() });
    attempts.current.delete(key);
    qc.setQueryData<BeadsResponse>(beadsKey(projectId), (list) => patchAnswered(list, body));
    const warning = item.warning?.(body) ?? null;
    if (warning) toast.warning(warning, { id: `outbox-${key}`, duration: Infinity, closeButton: true });
    else toast.success(text.done, { id: `outbox-${key}` });
  }, [apply, projectId, qc]);

  const run = React.useCallback(async (item: OutboxSend, queued: boolean): Promise<boolean> => {
    const key = outboxKey(projectId, item.id);
    const toastId = `outbox-${key}`;
    if (!queued) apply({ type: "send", id: key, kind: item.kind, draft: item.draft });
    const previous = attempts.current.get(key);
    const at = clickFor(previous && { fingerprint: previous.item.fingerprint, at: previous.sent.at }, item.fingerprint, Date.now());
    const sent: SentAnswer = { at, comment: item.comment, actor };
    attempts.current.set(key, { item, sent });
    toast.loading(outboxText(item.kind, item.id).sending, { id: toastId });
    try {
      // A request that hangs counts as a failure after the time limit: the item comes back.
      confirm(key, item, await item.request(AbortSignal.timeout(ANSWER_TIMEOUT_MS), at));
      return true;
    } catch (e) {
      // No answer came, or the board failed on its side: the write may have happened.
      // The item tells; only THIS answer counts (never someone else's close).
      let uncertain = false;
      if (mayHaveLanded(e)) {
        const found = await reread(item);
        if (found && answerLanded(item.kind, found.bead, found.comments, sent)) {
          confirm(key, item, found.bead);
          return true;
        }
        // Still uncertain unless the board has settled the item without this answer.
        uncertain = !found || !settledOnBoard(item.kind, found.bead);
      }
      const message = failureText(e);
      apply({ type: "failed", id: key, error: message, uncertain });
      toast.dismiss(toastId);
      // The board's own error goes as it is (toastError knows some codes); a dropped
      // connection or the time limit gets its plain words.
      toastError(e instanceof Error && e.message === message ? e : new Error(message));
      return false;
    } finally {
      void qc.invalidateQueries({ queryKey: beadsKey(projectId) });
    }
  }, [actor, apply, confirm, projectId, qc, reread]);

  // An uncertain failure (the page gave up, the board may still write): when the
  // board settles the item, read it again. This answer landed: it is sent after
  // all. Else the failure is certain (someone else closed it, say).
  React.useEffect(() => {
    for (const bead of beads) {
      const key = outboxKey(projectId, bead.id);
      const attempt = attempts.current.get(key);
      if (!attempt || rechecking.current.has(key) || !needsRecheck(box[key], bead)) continue;
      rechecking.current.add(key);
      void reread(attempt.item).then((found) => {
        if (found && answerLanded(attempt.item.kind, found.bead, found.comments, attempt.sent)) confirm(key, attempt.item, found.bead);
        else if (found) apply({ type: "settled", id: key });
      }).finally(() => rechecking.current.delete(key));
    }
  }, [apply, beads, box, confirm, projectId, reread]);

  const api_ = React.useMemo<OutboxApi>(() => ({
    hidden: (id) => isHidden(box[outboxKey(projectId, id)], listStartedAt),
    entry: (id) => box[outboxKey(projectId, id)],
    send: (item) => run(item, false),
    sendInOrder: async (items) => {
      for (const item of items) apply({ type: "send", id: outboxKey(projectId, item.id), kind: item.kind, draft: item.draft });
      for (let i = 0; i < items.length; i++) {
        if (await run(items[i], true)) continue;
        for (const rest of items.slice(i + 1)) apply({ type: "release", id: outboxKey(projectId, rest.id) });
        return false;
      }
      return true;
    },
    clear: (id) => apply({ type: "clear", id: outboxKey(projectId, id) }),
  }), [apply, box, listStartedAt, projectId, run]);

  return <OutboxContext.Provider value={api_}>{children}</OutboxContext.Provider>;
}

export function useAnswerOutbox(): OutboxApi {
  const ctx = React.useContext(OutboxContext);
  if (!ctx) throw new Error("useAnswerOutbox must be used within AnswerOutboxProvider");
  return ctx;
}

/** The draft a failed send left for this item, when it has the expected shape. */
export function failedDraft<T>(entry: OutboxEntry | undefined, valid: (draft: unknown) => draft is T): T | undefined {
  return entry?.state === "failed" && valid(entry.draft) ? entry.draft : undefined;
}
/**
 * A failed answer whose item someone else closed meanwhile: the card stays with
 * its error and what was typed, says the answer is not saved, and leaves on OK.
 */
export function ClosedMeanwhile({ bead, failed, route }: { bead: Bead; failed: boolean; route?: AnswerRoute }) {
  const outbox = useAnswerOutbox();
  if (route || !failed || needsHuman(bead)) return null;
  return (
    <div data-closed-meanwhile={bead.id} className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-2)]">
      <span>This question was closed meanwhile; your answer is not saved.</span>
      <button type="button" onClick={() => outbox.clear(bead.id)}
        className="h-7 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12px] font-[550] hover:bg-[var(--surface-3)]">OK</button>
    </div>
  );
}
