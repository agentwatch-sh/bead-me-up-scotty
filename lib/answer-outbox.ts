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

/** The key of an item in the outbox: per project, so two boards' items with the same id never meet. */
export function outboxKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id]);
}

/** How long the page waits for the board to take an answer; then the item comes back. */
export const ANSWER_TIMEOUT_MS = 30_000;

/**
 * The list, with `startedAt`: when it was requested (`now()` before the request,
 * not when it answers). A list requested before an answer's 2xx is older than
 * the answer, also when it arrives after it (see `isHidden`).
 */
export async function listWithStart<T extends object>(fetchList: () => Promise<T>, now: () => number = Date.now): Promise<T & { startedAt: number }> {
  const startedAt = now();
  return { ...(await fetchList()), startedAt };
}

/** The failed entry, when it is of one of `kinds`: an error shows only in the form of its own kind. */
export function failureFor(entry: OutboxEntry | undefined, kinds: readonly OutboxKind[]): Extract<OutboxEntry, { state: "failed" }> | undefined {
  return entry?.state === "failed" && kinds.includes(entry.kind) ? entry : undefined;
}

type Failure = { name?: unknown; status?: unknown; message?: unknown };
const failure = (e: unknown): Failure => (e && typeof e === "object" ? (e as Failure) : {});
/** No answer came: the connection failed, or the page stopped waiting. */
const noAnswer = (e: unknown) => ["TypeError", "AbortError", "TimeoutError"].includes(String(failure(e).name));

/**
 * Can the write have happened although the request failed? When no answer came
 * (a dropped connection, the time limit) or the board failed on its side (5xx),
 * yes: the item is read again to tell. A refusal (4xx: a stale question, no
 * password login) wrote nothing.
 */
export function mayHaveLanded(e: unknown): boolean {
  const status = failure(e).status;
  return noAnswer(e) || (typeof status === "number" && status >= 500);
}

/** The words the item shows for a failed write. */
export function failureText(e: unknown): string {
  const name = String(failure(e).name);
  if (name === "TimeoutError") return `The board did not answer within ${ANSWER_TIMEOUT_MS / 1000} s. Try again.`;
  if (noAnswer(e)) return "The answer did not reach the board: the connection failed. Try again.";
  const message = failure(e).message;
  return typeof message === "string" && message ? message : "The answer could not be saved.";
}

/** Does the item, read again, show that this answer was written? */
export function answerLanded(kind: OutboxKind, bead: Partial<Bead> | null | undefined): boolean {
  if (!bead) return false;
  const closedAs = (reason: string) => bead.status === "closed" && bead.close_reason === reason;
  switch (kind) {
    case "respond":
    case "answers":
      return closedAs("Responded");
    case "dismiss":
      return closedAs("Dismissed");
    case "decline":
      return closedAs("Declined");
    case "accept":
      return bead.metadata?.["board.review"] === "accepted";
    case "reverse":
      return bead.metadata?.["board.review"] === "reversed";
  }
}

/** The kinds of the Needs You answers; a form with a route (a Reverse) shows its route's kind only. */
export const HUMAN_KINDS: readonly OutboxKind[] = ["respond", "dismiss", "decline", "answers"];
