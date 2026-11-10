import type { Comment } from "./schema";

/**
 * Rules that tie a board answer to the click that sent it (agentwatch board
 * age-6mk, re-check rv-6mk-b). The page sends the click time with each answer
 * (`answered_at`); a retry of the same answer keeps it. The route and the page
 * use these rules to tell "this answer, already written" from "a new answer that
 * happens to have the same words".
 */

/** The skew allowed between the browser's clock (the click) and the board's clock (bd's times). */
export const CLOCK_SKEW_MS = 5_000;

/** A click time from a request body: ms, or null when it is missing or not a time. */
export function clickTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const timeOf = (c: Comment) => (c.created_at ? Date.parse(c.created_at) : NaN);
/** Written at or after the click, allowing for the clocks' skew. */
const afterClick = (c: Comment, clickedAt: number) => {
  const t = timeOf(c);
  return !Number.isNaN(t) && t >= clickedAt - CLOCK_SKEW_MS;
};

/** The newest comment: the latest `created_at`; on a tie or a time that does not parse, the later in the list. */
export function newestComment(comments: readonly Comment[]): Comment | undefined {
  let best: Comment | undefined;
  let bestAt = -Infinity;
  for (const c of comments) {
    const t = timeOf(c);
    const when = Number.isNaN(t) ? bestAt : t;
    if (when >= bestAt) {
      best = c;
      bestAt = when;
    }
  }
  return best;
}

/**
 * Is this answer already on the item from an earlier try of the same click? Only
 * when the item's newest comment, from anyone, is the actor's with the same text,
 * written after the click. A comment by someone else after it (the agent asks
 * again), a newer comment of the actor, or the same words from before the click
 * make it a new answer, which is written.
 */
export function savedByThisClick(comments: readonly Comment[], text: string, actor: string, clickedAt: number): boolean {
  const newest = newestComment(comments);
  return !!newest && newest.author === actor && newest.text === text && afterClick(newest, clickedAt);
}

/** Is the actor's newest comment this text, written after the click? (The answer's comment is there.) */
export function actorWroteAfter(comments: readonly Comment[], text: string, actor: string, clickedAt: number): boolean {
  const mine = newestComment(comments.filter((c) => c.author === actor));
  return !!mine && mine.text === text && afterClick(mine, clickedAt);
}
