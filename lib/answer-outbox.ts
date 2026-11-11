import type { Bead } from "./schema";
import { markedBy } from "./answer-click";

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
  /**
   * The write failed: the item is back with `error`, and the form with `draft`.
   * `uncertain`: no answer came, or the board failed on its side, and the item was
   * still open; the board may still write, so the item is checked again when the
   * board settles it (`needsRecheck`). `closedNow`: the item is closed or done now
   * (by anyone): the card says so in neutral words, and OK removes it.
   */
  | { state: "failed"; kind: OutboxKind; error: string; draft?: unknown; uncertain?: boolean; closedNow?: boolean };

export type Outbox = Readonly<Record<string, OutboxEntry>>;

export type OutboxEvent =
  | { type: "send"; id: string; kind: OutboxKind; draft?: unknown }
  /** The board took it: its 2xx. Nothing else makes an answer "sent". */
  | { type: "sent"; id: string; at: number }
  | { type: "failed"; id: string; error: string; uncertain?: boolean; closedNow?: boolean }
  /** An uncertain failure's item is closed or done now: the neutral case (re-check rv-6mk-d). */
  | { type: "closedNow"; id: string }
  /** A queued item that was never sent comes back as it was (Accept all stopped). */
  | { type: "release"; id: string }
  /** The operator dealt with a failure: its error goes. */
  | { type: "clear"; id: string };

/** The words of the three cases after an uncertain failure (`afterFailure`). */
export const SAVED_TEXT = "Your answer is saved; closing failed: try again.";
export const CLOSED_NOW_TEXT = "This question is closed now. Your answer may or may not be the one recorded: open the item to check.";

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
        ? { ...box, [event.id]: { state: "failed", kind: entry.kind, draft: entry.draft, error: event.error, uncertain: !!event.uncertain, closedNow: !!event.closedNow } }
        : box;
    case "closedNow":
      return entry?.state === "failed" && entry.uncertain
        ? { ...box, [event.id]: { ...entry, uncertain: false, closedNow: true, error: CLOSED_NOW_TEXT } }
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
  // The page gives up before the board does (one bd call may run 60 s): the
  // answer may still be written (re-check rv-6mk-b, Minor 1).
  if (name === "TimeoutError") {
    return `The board did not answer within ${ANSWER_TIMEOUT_MS / 1000} s; your answer may still be saved: check the item before answering again.`;
  }
  if (noAnswer(e)) return "The answer did not reach the board: the connection failed. Try again.";
  const message = failure(e).message;
  return typeof message === "string" && message ? message : "The answer could not be saved.";
}

/** What one answer sent: the id of its click (lib/answer-click.ts). */
export interface SentAnswer {
  clickId: string;
}

/**
 * After an uncertain failure (a lost response, the time limit, a 5xx), what the
 * item read again says, in three cases only (re-check rv-6mk-d). The page never
 * infers "sent" from the item: the mark comes before the close, so a closed item
 * with this click's mark does not say who closed it.
 *  - "saved": open (still waiting), with this click's mark: the comment is saved
 *    and the close is not; a retry only closes.
 *  - "failed": open, without this click's mark: the failure as it is.
 *  - "closed": closed or done now (by anyone, also with this click's mark): the
 *    neutral words, never "Responded" and never "not saved".
 * For Accept and Reverse the review record stands in place of the close.
 */
export function afterFailure(kind: OutboxKind, bead: Partial<Bead>, sent: SentAnswer): "saved" | "failed" | "closed" {
  if (settledOnBoard(kind, bead)) return "closed";
  // A review writes its mark with its record, so for Accept and Reverse a mark never means "saved".
  if (kind === "accept" || kind === "reverse") return "failed";
  return markedBy(bead.metadata, sent.clickId) ? "saved" : "failed";
}

/**
 * A new click id: crypto.randomUUID where the page has it (a secure context);
 * else one from crypto.getRandomValues; else from Math.random. Only uniqueness
 * matters: the id ties the tries of one click together.
 */
export function newClickId(c: { randomUUID?: () => string; getRandomValues?: (bytes: Uint8Array) => Uint8Array } | undefined = globalThis.crypto): string {
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The click id of an answer: a retry of the same answer (same fingerprint) keeps it; another answer is a new click. */
export function clickIdFor(previous: { fingerprint: string; clickId: string } | undefined, fingerprint: string, newId: () => string): string {
  return previous && previous.fingerprint === fingerprint ? previous.clickId : newId();
}

/** Is the item no longer waiting for this kind of answer on the board? */
export const settledOnBoard = (kind: OutboxKind, bead: Partial<Bead>) => (kind === "accept" || kind === "reverse"
  // A review is settled by its record (accepted, reversed), or by a close with no pending record; an
  // item open again (a Reverse that failed half-way: no review key, the human label) is not.
  ? ["accepted", "reversed"].includes(String(bead.metadata?.["board.review"])) || (bead.status === "closed" && bead.metadata?.["board.review"] !== "pending")
  : bead.status === "closed" || !(bead.labels ?? []).includes("human"));

/** An uncertain failure whose item the board has settled since: read it again, to tell whether this answer landed. */
export function needsRecheck(entry: OutboxEntry | undefined, bead: Partial<Bead> | undefined): boolean {
  return entry?.state === "failed" && !!entry.uncertain && !!bead && settledOnBoard(entry.kind, bead);
}

/** A failed Needs You answer keeps its card, also when the item left the inbox meanwhile; a To Review failure keeps its row when the review is in place now. */
export function keepsFailedCard(entry: OutboxEntry | undefined): boolean {
  return entry?.state === "failed" && (HUMAN_KINDS.includes(entry.kind) || !!entry.closedNow);
}

/** The kinds of the Needs You answers; a form with a route (a Reverse) shows its route's kind only. */
export const HUMAN_KINDS: readonly OutboxKind[] = ["respond", "dismiss", "decline", "answers"];

/**
 * Before a recheck confirms or settles: is its try still the item's latest send,
 * and the item still failed and uncertain? (The operator may have sent again, or
 * dealt with the failure, while the item was read: re-check rv-6mk-c, Minor 2.)
 */
export function recheckStillCurrent<A>(attemptNow: A | undefined, attemptThen: A, entryNow: OutboxEntry | undefined): boolean {
  return attemptNow === attemptThen && entryNow?.state === "failed" && !!entryNow.uncertain;
}
