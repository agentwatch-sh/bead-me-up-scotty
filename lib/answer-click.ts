/**
 * The click id of a board answer (agentwatch board age-6mk, re-check rv-6mk-c).
 * The page makes one random id per click (crypto.randomUUID) and sends it with
 * each try of that click (`click_id`); an edited answer is a new click with a new
 * id. Inside its queue slot the route writes the id on the item as
 * `scotty.answer_click`: after the comment, before the close (for an action with
 * no comment, before the close; for Accept and Reverse, with the review record).
 * So the item itself says which click answered it, with no clock involved:
 *  - a retry of the same click finds its mark and does not write the comment again;
 *  - an item that this click closed is done, a success with no write;
 *  - after a lost response, the page counts the answer as sent only when the item
 *    carries this click's mark; someone else's close or comment never does.
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
