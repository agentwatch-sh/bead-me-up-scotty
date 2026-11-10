"use client";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/components/error-toast";
import { beadsKey } from "@/hooks/use-beads";
import { api, type BeadsResponse } from "@/lib/api-client";
import type { HumanBody } from "@/lib/human-validate";
import {
  ANSWER_TIMEOUT_MS, answerLanded, failureText, isHidden, mayHaveLanded, outboxAfter, outboxKey, outboxText, patchAnswered,
  type Outbox, type OutboxEntry, type OutboxEvent, type OutboxKind,
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
  /** The write. Its 2xx body (the item) patches the list at once. It gets up to ANSWER_TIMEOUT_MS. */
  request: (signal: AbortSignal) => Promise<unknown>;
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
  const [box, setBox] = React.useState<Outbox>({});
  const apply = React.useCallback((event: OutboxEvent) => setBox((previous) => outboxAfter(previous, event)), []);

  const run = React.useCallback(async (item: OutboxSend, queued: boolean): Promise<boolean> => {
    const key = outboxKey(projectId, item.id);
    const text = outboxText(item.kind, item.id);
    const toastId = `outbox-${key}`;
    if (!queued) apply({ type: "send", id: key, kind: item.kind, draft: item.draft });
    toast.loading(text.sending, { id: toastId });
    const sent = (body: unknown) => {
      // The board's word on the item, before any list: an older list never brings it back.
      apply({ type: "sent", id: key, at: Date.now() });
      qc.setQueryData<BeadsResponse>(beadsKey(projectId), (list) => patchAnswered(list, body));
      const warning = item.warning?.(body) ?? null;
      if (warning) toast.warning(warning, { id: toastId, duration: Infinity, closeButton: true });
      else toast.success(text.done, { id: toastId });
      return true;
    };
    try {
      // A request that hangs counts as a failure after the time limit: the item comes back.
      return sent(await item.request(AbortSignal.timeout(ANSWER_TIMEOUT_MS)));
    } catch (e) {
      // No answer came, or the board failed on its side: the write may have happened.
      // The item tells; when it shows this answer, the answer is sent.
      if (mayHaveLanded(e)) {
        try {
          const bead = await api.get(projectId, item.id, AbortSignal.timeout(REREAD_TIMEOUT_MS));
          if (answerLanded(item.kind, bead)) return sent(bead);
        } catch {
          // The item could not be read: the failure stands.
        }
      }
      const message = failureText(e);
      apply({ type: "failed", id: key, error: message });
      toast.dismiss(toastId);
      // The board's own error goes as it is (toastError knows some codes); a dropped
      // connection or the time limit gets its plain words.
      toastError(e instanceof Error && e.message === message ? e : new Error(message));
      return false;
    } finally {
      void qc.invalidateQueries({ queryKey: beadsKey(projectId) });
    }
  }, [apply, projectId, qc]);

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
