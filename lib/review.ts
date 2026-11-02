import type { Bead } from "./schema";
import type { BeadsStore } from "./store";

/** agentwatch's names for the review record (agentwatch/board/contract.py). */
export const REVIEW_KEY = "board.review";
export const REVIEW_BY_KEY = "board.review_by";
export const REVIEW_REASON_KEY = "board.review_reason";
export const REVIEWED_BY_KEY = "board.reviewed_by";
export const REVIEWED_AT_KEY = "board.reviewed_at";
export const ACKED_KEY = "board.acked";

const ITEM_LABELS = ["question", "assumption", "blocker"];

type Answer = { author: string; text: string };

/**
 * The latest comment by a `human:*` or `manager:*` author made at or before
 * `closed_at`: the answer, as agentwatch reads it. A discussion comment on the
 * closed item (later than `closed_at`) is not an answer, so it never takes the
 * row out of To Review.
 */
function latestAnswer(bead: Bead): Answer | null {
  const closedAt = bead.closed_at ? Date.parse(bead.closed_at) : NaN;
  let best: Answer | null = null;
  let bestAt = -Infinity;
  for (const c of bead.comments ?? []) {
    if (!c.author.startsWith("human:") && !c.author.startsWith("manager:")) continue;
    const at = c.created_at ? Date.parse(c.created_at) : NaN;
    if (!Number.isNaN(at) && !Number.isNaN(closedAt) && at > closedAt) continue;
    const when = Number.isNaN(at) ? Infinity : at;
    if (when >= bestAt) {
      best = { author: c.author, text: c.text };
      bestAt = when;
    }
  }
  return best;
}

export function latestAnswerAuthor(bead: Bead): string | null {
  return latestAnswer(bead)?.author ?? null;
}

/** A closed item whose pending review holds a manager's answer, still the latest answer. */
export function needsReview(bead: Bead): boolean {
  if (bead.status !== "closed" || !bead.labels.includes("human")) return false;
  if (!bead.labels.some((l) => ITEM_LABELS.includes(l))) return false;
  if (bead.metadata?.[REVIEW_KEY] !== "pending") return false;
  const author = latestAnswerAuthor(bead);
  if (author !== null) return author.startsWith("manager:");
  const by = bead.metadata?.[REVIEW_BY_KEY];
  return typeof by === "string" && by.startsWith("manager:");
}

export function managerAnswer(bead: Bead): Answer | null {
  const answer = latestAnswer(bead);
  return answer && answer.author.startsWith("manager:") ? answer : null;
}

export function reviewCount(beads: Bead[]): number {
  return beads.filter(needsReview).length;
}

export type ReverseCode = "reverse_not_started" | "reverse_incomplete";

export class ReverseError extends Error {
  code: ReverseCode;
  /** True when the review keys were removed, so the question is back in Needs You. */
  reviewRemoved: boolean;
  constructor(code: ReverseCode, reviewRemoved = false) {
    super(code);
    this.name = "ReverseError";
    this.code = code;
    this.reviewRemoved = reviewRemoved;
  }
}

type ReverseStore = Pick<BeadsStore, "reopen" | "addComment" | "setMetadata" | "setStatus">;

/**
 * Reverse a manager's answer: reopen, the operator's comment, unset
 * `board.acked` (only when the item holds it), close, and the `reversed`
 * review record last. A failure before the close leaves the item open, so the
 * review keys go (best effort) and the question is back in Needs You.
 */
export async function reverseAnswer(
  store: ReverseStore,
  id: string,
  comment: string | null,
  reason: string,
  actor: string,
  acked: boolean,
  now: () => string,
): Promise<{ bead: Bead; warning?: "review_record_failed" }> {
  try {
    await store.reopen(id, actor);
  } catch {
    throw new ReverseError("reverse_not_started");
  }
  let closed: Bead;
  try {
    if (comment !== null) await store.addComment(id, comment, actor);
    if (acked) await store.setMetadata(id, { [ACKED_KEY]: null }, actor);
    closed = await store.setStatus(id, "closed", actor, reason);
  } catch {
    let removed = false;
    try {
      await store.setMetadata(id, { [REVIEW_KEY]: null, [REVIEW_BY_KEY]: null, [REVIEW_REASON_KEY]: null }, actor);
      removed = true;
    } catch {
      removed = false;
    }
    throw new ReverseError("reverse_incomplete", removed);
  }
  try {
    const bead = await store.setMetadata(
      id,
      { [REVIEW_KEY]: "reversed", [REVIEWED_BY_KEY]: actor, [REVIEWED_AT_KEY]: now() },
      actor,
    );
    return { bead };
  } catch {
    return { bead: closed, warning: "review_record_failed" };
  }
}
