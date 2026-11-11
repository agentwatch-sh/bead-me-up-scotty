/**
 * The click id of a board answer (agentwatch board age-6mk, re-check rv-6mk-c).
 * The page makes one random id per click (crypto.randomUUID, else from
 * crypto.getRandomValues) and sends it with each try of that click (`click_id`);
 * an edited answer is a new click with a new id. Inside its queue slot the route
 * writes the id on the item as `scotty.answer_click`: after the comment, before
 * the close (for an action with no comment, before the close; for Accept and
 * Reverse, with the review record). What the mark says, and no more:
 *  - on an OPEN item, this click's comment is saved: a retry of the same click
 *    does not write it again, and after a lost response the page says "saved;
 *    closing failed: try again";
 *  - on a closed or done item it says nothing about who closed it (the mark comes
 *    before the close, and another writer can close in between): the route
 *    answers stale_question and the page shows neutral words (re-check rv-6mk-d).
 */
export const ANSWER_CLICK_KEY = "scotty.answer_click";

/** A click id from a request body, or null when it is missing or not one. */
export function clickIdOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null;
}

/** Does the item carry this click's mark? */
export function markedBy(metadata: Record<string, unknown> | undefined | null, clickId: string | null): boolean {
  return clickId !== null && metadata?.[ANSWER_CLICK_KEY] === clickId;
}
