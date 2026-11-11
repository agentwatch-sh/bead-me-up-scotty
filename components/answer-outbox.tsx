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
import type { Bead } from "@/lib/schema";
import {
  ANSWER_TIMEOUT_MS, CLOSED_NOW_TEXT, SAVED_TEXT, afterFailure, clickIdFor, failureText, isHidden, mayHaveLanded, needsRecheck, newClickId,
  outboxAfter, outboxKey, outboxText,
  patchAnswered, recheckStillCurrent, type Outbox, type OutboxEntry, type OutboxEvent, type OutboxKind, type SentAnswer,
} from "@/lib/answer-outbox";

/** Where an answer goes instead of the human route (To Review sends a Reverse). */
export interface AnswerRoute {
  kind: OutboxKind;
  request: (body: HumanBody, signal: AbortSignal, clickId: string) => Promise<unknown>;
  /** A 2xx that still needs the operator: a warning instead of the confirmation. */
  warning?: (body: unknown) => string | null;
}

export interface OutboxSend {
  id: string;
  kind: OutboxKind;
  /**
   * The write. It gets up to ANSWER_TIMEOUT_MS, and the click's id
   * (lib/answer-click.ts): a retry of the same answer keeps its click's id, so
   * the board writes it once. Its 2xx body (the item) patches the list at once.
   */
  request: (signal: AbortSignal, clickId: string) => Promise<unknown>;
  /** The same answer has the same fingerprint (its request body); an edited answer is a new click. */
  fingerprint: string;
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

type Attempt = { item: OutboxSend; sent: SentAnswer };

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
  const { beads } = useApp();
  const [box, setBox] = React.useState<Outbox>({});
  // The box as it is now, for a recheck that ends after later sends.
  const boxNow = React.useRef(box);
  React.useEffect(() => { boxNow.current = box; }, [box]);
  const apply = React.useCallback((event: OutboxEvent) => setBox((previous) => outboxAfter(previous, event)), []);
  // Per item: the last answer sent (for a retry's click id and for a later check).
  const attempts = React.useRef(new Map<string, Attempt>());
  const rechecking = React.useRef(new Set<string>());

  /** The item read again (it carries the click's mark); null when it cannot be read. */
  const reread = React.useCallback(async (item: OutboxSend): Promise<Bead | null> => {
    try {
      return await api.get(projectId, item.id, AbortSignal.timeout(REREAD_TIMEOUT_MS));
    } catch {
      return null;
    }
  }, [projectId]);

  /** The list with the item as the board has it now (a 2xx body, or a fresh read). */
  const patch = React.useCallback((bead: unknown) => {
    qc.setQueryData<BeadsResponse>(beadsKey(projectId), (list) => patchAnswered(list, bead));
  }, [projectId, qc]);

  const confirm = React.useCallback((key: string, item: OutboxSend, body: unknown) => {
    // The board's word on the item, before any list: an older list never brings it back.
    apply({ type: "sent", id: key, at: Date.now() });
    attempts.current.delete(key);
    patch(body);
    const warning = item.warning?.(body) ?? null;
    if (warning) toast.warning(warning, { id: `outbox-${key}`, duration: Infinity, closeButton: true });
    else toast.success(outboxText(item.kind, item.id).done, { id: `outbox-${key}` });
  }, [apply, patch]);

  const run = React.useCallback(async (item: OutboxSend, queued: boolean): Promise<boolean> => {
    const key = outboxKey(projectId, item.id);
    const toastId = `outbox-${key}`;
    if (!queued) apply({ type: "send", id: key, kind: item.kind, draft: item.draft });
    toast.loading(outboxText(item.kind, item.id).sending, { id: toastId });
    let attempt: Attempt | undefined;
    try {
      // The click's id, made inside the try: nothing before the request can leave the
      // item hidden for good (newClickId works without crypto.randomUUID too).
      const previous = attempts.current.get(key);
      const clickId = clickIdFor(previous && { fingerprint: previous.item.fingerprint, clickId: previous.sent.clickId },
        item.fingerprint, () => newClickId());
      attempt = { item, sent: { clickId } };
      attempts.current.set(key, attempt);
      // A request that hangs counts as a failure after the time limit: the item comes back.
      confirm(key, item, await item.request(AbortSignal.timeout(ANSWER_TIMEOUT_MS), clickId));
      return true;
    } catch (e) {
      // No answer came, or the board failed on its side: the write may have happened.
      // The item, read again, decides one of three cases; it never makes the answer "sent".
      let message = failureText(e);
      let uncertain = false;
      let closedNow = false;
      if (attempt && mayHaveLanded(e)) {
        uncertain = true;
        const found = await reread(item);
        if (found) {
          // The list shows the item as the board has it now: a closed item's form is disabled at once.
          patch(found);
          const outcome = afterFailure(item.kind, found, attempt.sent);
          if (outcome === "saved") message = SAVED_TEXT;
          if (outcome === "closed") {
            message = CLOSED_NOW_TEXT;
            uncertain = false;
            closedNow = true;
            // Closed now: its try goes too, so a later answer on a reopened item is a new click.
            attempts.current.delete(key);
          }
        }
      }
      apply({ type: "failed", id: key, error: message, uncertain, closedNow });
      toast.dismiss(toastId);
      // The board's own error goes as it is (toastError knows some codes); a dropped
      // connection, the time limit and the three cases get their plain words.
      toastError(e instanceof Error && e.message === message ? e : new Error(message));
      return false;
    } finally {
      void qc.invalidateQueries({ queryKey: beadsKey(projectId) });
    }
  }, [apply, confirm, patch, projectId, qc, reread]);

  // An uncertain failure (the page gave up, the board may still write): when the
  // board settles the item, the card takes the neutral words (closed now, by
  // anyone); it never becomes "sent". A check acts only when its try is still the
  // item's latest and the item still failed and uncertain.
  React.useEffect(() => {
    for (const bead of beads) {
      const key = outboxKey(projectId, bead.id);
      const attempt = attempts.current.get(key);
      if (!attempt || rechecking.current.has(key) || !needsRecheck(box[key], bead)) continue;
      rechecking.current.add(key);
      void reread(attempt.item).then((found) => {
        if (!found || !recheckStillCurrent(attempts.current.get(key), attempt, boxNow.current[key])) return;
        patch(found);
        if (afterFailure(attempt.item.kind, found, attempt.sent) === "closed") {
          // Closed now: its try goes too, so a later answer on a reopened item is a new click.
          attempts.current.delete(key);
          apply({ type: "closedNow", id: key });
        }
      }).finally(() => rechecking.current.delete(key));
    }
  }, [apply, beads, box, patch, projectId, reread]);

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
    clear: (id) => {
      const key = outboxKey(projectId, id);
      // A card closed now goes with its try: a later answer on a reopened item is a new click.
      const was = box[key];
      if (was?.state === "failed" && was.closedNow) attempts.current.delete(key);
      apply({ type: "clear", id: key });
    },
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
 * A failed answer whose item is closed or done now (by anyone): the card stays
 * with the neutral words (its error) and what was typed; OK removes it.
 */
export function ClosedMeanwhile({ bead, failed, route }: { bead: Bead; failed: OutboxEntry | undefined; route?: AnswerRoute }) {
  const outbox = useAnswerOutbox();
  // Closed now (the neutral case), or refused after the item left the inbox: OK removes the card.
  if (route || failed?.state !== "failed" || (!failed.closedNow && needsHuman(bead))) return null;
  return (
    <div data-closed-meanwhile={bead.id} className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-2)]">
      <button type="button" onClick={() => outbox.clear(bead.id)}
        className="h-7 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12px] font-[550] hover:bg-[var(--surface-3)]">OK</button>
    </div>
  );
}
