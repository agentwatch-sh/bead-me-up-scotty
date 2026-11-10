import type { Bead } from "./schema";

/**
 * The answer outbox (agentwatch board age-6mk): the operator's answers and
 * reviews that are on their way to the board. An answer took 3 to 13 seconds to
 * be written (each bd call reads the whole Dolt store), and the item stayed in
 * its list until a full list arrived after it. Now the item leaves its list at
 * the click; the write runs on; a failed write brings the item back in its
 * place, with its error and what the operator had typed.
 *
 * Pure rules here; the React side is components/answer-outbox.tsx.
 */

/** What was sent: a Needs You answer, a group of answers, or a review in To Review. */
export type OutboxKind = "respond" | "dismiss" | "decline" | "answers" | "accept" | "reverse";

export type OutboxEntry =
  /** The write runs. */
  | { state: "sending"; kind: OutboxKind; draft?: unknown }
  /** The board answered 2xx at `at` (ms, this browser's clock). */
  | { state: "sent"; kind: OutboxKind; at: number }
  /** The write failed: the item is back with `error`, and the form with `draft`. */
  | { state: "failed"; kind: OutboxKind; error: string; draft?: unknown };

export type Outbox = Readonly<Record<string, OutboxEntry>>;

export type OutboxEvent =
  | { type: "send"; id: string; kind: OutboxKind; draft?: unknown }
  | { type: "sent"; id: string; at: number }
  | { type: "failed"; id: string; error: string }
  /** A queued item that was never sent comes back as it was (Accept all stopped). */
  | { type: "release"; id: string }
  /** The operator dealt with a failure: its error goes. */
  | { type: "clear"; id: string };

/** The outbox after `event`; the given outbox is never changed. */
export function outboxAfter(box: Outbox, event: OutboxEvent): Outbox {
  const entry = box[event.id];
  const without = () => {
    const next = { ...box };
    delete next[event.id];
    return next;
  };
  switch (event.type) {
    case "send":
      return { ...box, [event.id]: { state: "sending", kind: event.kind, draft: event.draft } };
    case "sent":
      return entry?.state === "sending" ? { ...box, [event.id]: { state: "sent", kind: entry.kind, at: event.at } } : box;
    case "failed":
      return entry?.state === "sending"
        ? { ...box, [event.id]: { state: "failed", kind: entry.kind, draft: entry.draft, error: event.error } }
        : box;
    case "release":
      return entry?.state === "sending" ? without() : box;
    case "clear":
      return entry?.state === "failed" ? without() : box;
  }
}

/**
 * Is the item out of its list? While its write runs; and after the 2xx, until a
 * list arrives that was requested after the 2xx (`listStartedAt`, this browser's
 * clock). An older list, requested before the write was done, can still show the
 * item open: it never brings the item back. A failed write shows the item.
 */
export function isHidden(entry: OutboxEntry | undefined, listStartedAt: number | undefined): boolean {
  if (!entry) return false;
  if (entry.state === "sending") return true;
  if (entry.state === "sent") return listStartedAt === undefined || listStartedAt <= entry.at;
  return false;
}

/** The fields of the answered item that the 2xx body carries and the list must show at once. */
const ANSWER_FIELDS = ["status", "close_reason", "closed_at", "updated_at", "labels", "metadata"] as const;

/**
 * The list with the answered item as the board's 2xx body has it. Only the
 * answer's own fields: `bd show` leaves the comments out, and the list keeps its
 * own until the next list arrives. A body with no item of the list changes nothing.
 */
export function patchAnswered<T extends { beads: Bead[] }>(list: T | undefined, body: unknown): T | undefined {
  if (!list || !body || typeof body !== "object") return list;
  const shown = body as Partial<Bead>;
  if (typeof shown.id !== "string" || !list.beads.some((b) => b.id === shown.id)) return list;
  const fields: Partial<Bead> = {};
  for (const key of ANSWER_FIELDS) {
    if (key in shown) (fields as Record<string, unknown>)[key] = shown[key];
  }
  return { ...list, beads: list.beads.map((b) => (b.id === shown.id ? { ...b, ...fields } : b)) };
}

/** The words for one item: "Sending…" at the click, a short confirmation after the 2xx. */
export function outboxText(kind: OutboxKind, id: string): { sending: string; done: string } {
  switch (kind) {
    case "respond":
      return { sending: `Sending your answer to ${id}…`, done: `Responded to ${id}` };
    case "answers":
      return { sending: `Sending your answers to ${id}…`, done: `Answered ${id}` };
    case "dismiss":
      return { sending: `Sending your dismissal of ${id}…`, done: `Dismissed ${id}` };
    case "decline":
      return { sending: `Sending your decline of ${id}…`, done: `Declined ${id}` };
    case "accept":
      return { sending: `Sending your review of ${id}…`, done: `Accepted the answer to ${id}` };
    case "reverse":
      return { sending: `Sending your answer to ${id}…`, done: `Reversed the answer to ${id}` };
  }
}
