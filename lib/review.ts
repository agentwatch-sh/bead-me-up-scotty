import type { Bead } from "./schema";
import type { BeadsStore } from "./store";
import { isItem } from "./beads-view";

/** agentwatch's names for the review record (agentwatch/board/contract.py). */
export const REVIEW_KEY = "board.review";
export const REVIEW_BY_KEY = "board.review_by";
export const REVIEW_REASON_KEY = "board.review_reason";
export const REVIEWED_BY_KEY = "board.reviewed_by";
export const REVIEWED_AT_KEY = "board.reviewed_at";
export const ACKED_KEY = "board.acked";
/**
 * An agent's answer with a checked cite of the operator's chat words (agentwatch
 * age-29t6): the review record above, by the agent, plus these four keys. Only
 * the user's agentwatch daemon writes them, for a cite that its gateway checked.
 */
export const REVIEW_CITE_SESSION_KEY = "board.review_cite_session";
export const REVIEW_CITE_TYPED_AT_KEY = "board.review_cite_typed_at";
export const REVIEW_CITE_WORDS_KEY = "board.review_cite_words";
export const REVIEW_CITE_RECORD_KEY = "board.review_cite_record";

type Answer = { author: string; text: string };
/** The facts of a cited answer that To Review shows: the session and the UTC time where the operator typed the words, and the words. */
export type Cite = { session: string; typedAt: string; words: string };

const REVIEW_STATES = ["pending", "accepted", "reversed"];
/** agentwatch's `LINK_MACHINE_RE` and `LINK_AGENT_RE` (board/contract.py). */
const LINK_MACHINE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LINK_AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A well-formed `link:<machine>/<agent>` actor (agentwatch's `parse_link_actor`). */
function isLinkActor(actor: string): boolean {
  if (!actor.startsWith("link:")) return false;
  const rest = actor.slice("link:".length);
  const slash = rest.indexOf("/");
  return slash >= 0 && LINK_MACHINE.test(rest.slice(0, slash)) && LINK_AGENT.test(rest.slice(slash + 1));
}

/** An `agent:<session>` actor with no subagent (agentwatch's `parse_agent_actor` with no sub). */
function isSessionActor(actor: string): boolean {
  return actor.startsWith("agent:") && actor.length > "agent:".length && !actor.includes("/");
}

/**
 * The agent that answered `bead` with a cite of the operator's chat words, or
 * null: the rule of agentwatch's `logic.cited_answerer` (age-29t6).
 * `board.review_by` when `board.review` is `pending`, `accepted` or `reversed`,
 * `board.review_cite_record` is a string, and `board.review_by` is an
 * `agent:<session>` (no subagent) or a `link:` actor. It names who claims a
 * cited answer; agentwatch's gateway row of that actor confirms it.
 */
export function citedAnswerer(bead: Pick<Bead, "metadata">): string | null {
  const meta = bead.metadata ?? {};
  const by = meta[REVIEW_BY_KEY];
  if (!REVIEW_STATES.includes(meta[REVIEW_KEY] as string) || typeof by !== "string" || typeof meta[REVIEW_CITE_RECORD_KEY] !== "string") return null;
  return isLinkActor(by) || isSessionActor(by) ? by : null;
}

/**
 * An author whose comment can be an item's answer (agentwatch's
 * `answer_comments`): the board user, any `link:`, any `manager:`, and the
 * agent that the item's review keys name for a cited answer (`citedBy`).
 */
function isAnswerAuthor(author: string, humanActor: string, citedBy: string | null = null): boolean {
  return author === humanActor || author.startsWith("link:") || author.startsWith("manager:") || (citedBy !== null && author === citedBy);
}

/**
 * The latest comment by an answer author (the board user `humanActor`, any
 * `link:` agent, any `manager:`, and `citedBy` when given) made at or before
 * `closed_at`: the answer, as agentwatch reads it. A discussion comment on the
 * closed item (later than `closed_at`) is not an answer. A comment whose time
 * does not parse keeps its place in the list order, as in agentwatch.
 */
export function latestAnswer(bead: Pick<Bead, "comments" | "closed_at">, humanActor: string, citedBy: string | null = null): Answer | null {
  const closedAt = bead.closed_at ? Date.parse(bead.closed_at) : NaN;
  let best: Answer | null = null;
  let bestAt = -Infinity;
  for (const c of bead.comments ?? []) {
    if (!isAnswerAuthor(c.author, humanActor, citedBy)) continue;
    const at = c.created_at ? Date.parse(c.created_at) : NaN;
    if (!Number.isNaN(at) && !Number.isNaN(closedAt) && at > closedAt) continue;
    const when = Number.isNaN(at) ? bestAt : at;
    if (when >= bestAt) {
      best = { author: c.author, text: c.text };
      bestAt = when;
    }
  }
  return best;
}

export function latestAnswerAuthor(bead: Bead, humanActor: string): string | null {
  return latestAnswer(bead, humanActor, citedAnswerer(bead))?.author ?? null;
}

/** A manager's answer, or the cited answer of `citedBy`: the answers To Review lists. */
const isReviewAuthor = (author: string, citedBy: string | null) => author.startsWith("manager:") || (citedBy !== null && author === citedBy);

/**
 * A closed item whose pending review holds a manager's answer, or an agent's
 * answer with a checked cite of the operator's chat words (`citedAnswerer`,
 * agentwatch age-29t6), still the latest answer. A dismissal writes no comment
 * (a free-text item): it shows too when the item is closed `Dismissed`,
 * `board.review_by` is a manager or the cited agent, and no answer comment
 * exists at or before the close. (An operator comment on the open item followed
 * by a comment-less dismissal stays out.)
 */
export function needsReview(bead: Bead, humanActor: string): boolean {
  if (bead.status !== "closed" || !bead.labels.includes("human") || !isItem(bead)) return false;
  if (bead.metadata?.[REVIEW_KEY] !== "pending") return false;
  const citedBy = citedAnswerer(bead);
  const author = latestAnswer(bead, humanActor, citedBy)?.author ?? null;
  if (author !== null) return isReviewAuthor(author, citedBy);
  const by = bead.metadata?.[REVIEW_BY_KEY];
  return bead.close_reason === "Dismissed" && typeof by === "string" && isReviewAuthor(by, citedBy);
}

export function managerAnswer(bead: Bead, humanActor: string): Answer | null {
  const answer = latestAnswer(bead, humanActor);
  return answer && answer.author.startsWith("manager:") ? answer : null;
}

/** A cite key as text: a key that is missing or not a string shows as empty. */
const citeText = (bead: Pick<Bead, "metadata">, key: string): string => {
  const value = bead.metadata?.[key];
  return typeof value === "string" ? value : "";
};

/**
 * The answer that a To Review row shows: a manager's answer as `managerAnswer`
 * gives it, or the cited agent's answer with its cite (the session, the UTC time
 * and the operator's words, from the item's cite keys). A comment-less cited
 * dismissal is the cited agent's with empty text. Null for any other item (a
 * comment-less manager dismissal too, as `managerAnswer`).
 */
export function reviewAnswer(bead: Bead, humanActor: string): (Answer & { cite?: Cite }) | null {
  const citedBy = citedAnswerer(bead);
  const answer = latestAnswer(bead, humanActor, citedBy);
  if (answer && answer.author.startsWith("manager:")) return answer;
  if (citedBy === null) return null;
  const cite: Cite = {
    session: citeText(bead, REVIEW_CITE_SESSION_KEY),
    typedAt: citeText(bead, REVIEW_CITE_TYPED_AT_KEY),
    words: citeText(bead, REVIEW_CITE_WORDS_KEY),
  };
  if (answer) return answer.author === citedBy ? { ...answer, cite } : null;
  return bead.close_reason === "Dismissed" && bead.metadata?.[REVIEW_BY_KEY] === citedBy ? { author: citedBy, text: "", cite } : null;
}

export function reviewCount(beads: Bead[], humanActor: string): number {
  return beads.filter((b) => needsReview(b, humanActor)).length;
}

/**
 * An error as a server log line may show it: its name, and its code when the
 * code is a plain token. Never its message: bd's message can hold its argv,
 * and `bd comment ID TEXT` puts the operator's answer text there.
 */
export function errorTag(err: unknown): string {
  if (!(err instanceof Error)) return "a non-Error value";
  const code = (err as { code?: unknown }).code;
  const plain = (typeof code === "string" || typeof code === "number") && /^[A-Za-z0-9_.-]{1,64}$/.test(String(code));
  return plain ? `${err.name} (${code})` : err.name;
}

export type ReverseCode = "reverse_not_started" | "reverse_incomplete";

export class ReverseError extends Error {
  code: ReverseCode;
  /** True when the review keys were removed, so the question is back in Needs You. */
  reviewRemoved: boolean;
  constructor(code: ReverseCode, reviewRemoved = false, cause?: unknown) {
    super(code, { cause });
    this.name = "ReverseError";
    this.code = code;
    this.reviewRemoved = reviewRemoved;
  }
}

export type ReverseStore = Pick<BeadsStore, "get" | "reopen" | "addComment" | "setMetadata" | "setStatus">;

/**
 * Reverse a manager's answer: reopen, the operator's comment, unset
 * `board.acked` (only when the item holds it), close, and the `reversed`
 * review record last. A failure before the close leaves the item open, so the
 * review keys (and `board.acked`, when it is still held) go, best effort, and
 * the question is back in Needs You. `reopen` and `setStatus` end with a read,
 * so a throw can follow a write that worked: the item is read again to tell.
 */
export async function reverseAnswer(
  store: ReverseStore,
  id: string,
  comment: string | null,
  reason: string,
  actor: string,
  acked: boolean,
  now: () => string,
  /** More keys for the final review record (the click's mark, lib/answer-click.ts). */
  record: Record<string, string> = {},
): Promise<{ bead: Bead; warning?: "review_record_failed" }> {
  const reread = async (): Promise<Bead | null> => {
    try {
      return await store.get(id);
    } catch {
      return null;
    }
  };
  try {
    await store.reopen(id, actor);
  } catch (e) {
    const found = await reread();
    if (!found || found.status === "closed") throw new ReverseError("reverse_not_started", false, e);
  }
  let ackedHeld = acked;
  let closed: Bead | null = null;
  let step: "comment" | "unset" | "close" = "comment";
  try {
    if (comment !== null) await store.addComment(id, comment, actor);
    step = "unset";
    if (acked) {
      await store.setMetadata(id, { [ACKED_KEY]: null }, actor);
      ackedHeld = false;
    }
    step = "close";
    closed = await store.setStatus(id, "closed", actor, reason);
  } catch (e) {
    const found = await reread();
    // Only a failed close can have worked: another writer's same-reason close after a failed comment or unset is not ours.
    if (step === "close" && found && found.status === "closed" && found.close_reason === reason) {
      closed = found; // the close worked; only its trailing read failed
    } else {
      const cleanup: Record<string, null> = { [REVIEW_KEY]: null, [REVIEW_BY_KEY]: null, [REVIEW_REASON_KEY]: null };
      if (ackedHeld) cleanup[ACKED_KEY] = null;
      let removed = false;
      try {
        await store.setMetadata(id, cleanup, actor);
        removed = true;
      } catch {
        removed = false;
      }
      throw new ReverseError("reverse_incomplete", removed, e);
    }
  }
  try {
    const bead = await store.setMetadata(
      id,
      { [REVIEW_KEY]: "reversed", [REVIEWED_BY_KEY]: actor, [REVIEWED_AT_KEY]: now(), ...record },
      actor,
    );
    return { bead };
  } catch {
    return { bead: closed as Bead, warning: "review_record_failed" };
  }
}
