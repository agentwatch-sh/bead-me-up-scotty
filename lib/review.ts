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
/** When the answer under review was given (agentwatch's daemon: UTC with milliseconds). */
export const REVIEW_ANSWERED_AT_KEY = "board.review_answered_at";

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
 * From when the cited agent's comment can be its answer: the whole second of
 * `board.review_answered_at` (bd keeps whole seconds, agentwatch's daemon
 * milliseconds); NaN when the item holds no time that parses. agentwatch's
 * `_cited_since` (age-29t6).
 */
function citedSince(bead: Partial<Pick<Bead, "metadata">>): number {
  const value = bead.metadata?.[REVIEW_ANSWERED_AT_KEY];
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(at) ? NaN : Math.floor(at / 1000) * 1000;
}

/**
 * An author whose comment can be an item's answer (agentwatch's
 * `answer_comments`): the board user, any `link:`, any `manager:`, and the
 * agent that the item's review keys name for a cited answer (`citedBy`). The
 * cited agent's comment counts only when made at or after its answer (`since`,
 * also for a `link:` agent): its earlier comment (on its own question, say) is
 * never the answer of a cited Dismiss that wrote none.
 */
function isAnswerAuthor(author: string, humanActor: string, at: number, citedBy: string | null = null, since = NaN): boolean {
  if (citedBy !== null && author === citedBy) return !Number.isNaN(since) && !Number.isNaN(at) && at >= since;
  return author === humanActor || author.startsWith("link:") || author.startsWith("manager:");
}

/**
 * The latest comment by an answer author (the board user `humanActor`, any
 * `link:` agent, any `manager:`, and `citedBy` when given, its comments only
 * from `board.review_answered_at` on) made at or before
 * `closed_at`: the answer, as agentwatch reads it. A discussion comment on the
 * closed item (later than `closed_at`) is not an answer. A comment whose time
 * does not parse keeps its place in the list order, as in agentwatch.
 */
export function latestAnswer(bead: Pick<Bead, "comments" | "closed_at"> & Partial<Pick<Bead, "metadata">>, humanActor: string, citedBy: string | null = null): Answer | null {
  const closedAt = bead.closed_at ? Date.parse(bead.closed_at) : NaN;
  const since = citedBy !== null ? citedSince(bead) : NaN;
  let best: Answer | null = null;
  let bestAt = -Infinity;
  for (const c of bead.comments ?? []) {
    const at = c.created_at ? Date.parse(c.created_at) : NaN;
    if (!isAnswerAuthor(c.author, humanActor, at, citedBy, since)) continue;
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

/** The body of the host's cite check of a cited answer (SCOTTY_CITE_CHECK_URL). */
export type CiteCheckBody = {
  id: string; close_reason: string; closed_at: string; review_by: string;
  comment_sha256: string | null; cite: Record<string, string>;
};

/** SHA-256's round constants (FIPS 180-4). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** The SHA-256 of `bytes`, lowercase hex. Synchronous, so it needs no secure context (Web Crypto does). */
function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  // The message, a 1 bit, zeros, and the bit length in the last 8 bytes of a 64-byte block.
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

/** True when `text` has no lone surrogate, so it has a UTF-8 form. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}

/**
 * The SHA-256 (lowercase hex) of a comment's text as UTF-8: how agentwatch's
 * `board answers` hashes the comment it shows, to compare it with its row's
 * `choice_digest` (agentwatch's `board.cited.comment_digest`, age-29t6). "" for
 * a text with a lone surrogate (no UTF-8 form), which no digest names.
 */
export function commentDigest(text: string): string {
  return wellFormed(text) ? sha256Hex(new TextEncoder().encode(text)) : "";
}

/**
 * What To Review asks the host (agentwatch's `POST /api/board/cite-check`) about
 * a cited answer: the item, its close, `board.review_by`, the digest of the
 * comment that the row shows as the answer (`comment_sha256`: `commentDigest` of
 * the cited agent's comment that `reviewAnswer` takes; null when the row shows
 * none, a comment-less cited Dismiss) and its four cite keys (the ones that are
 * strings). The host answers `{"bound": true}` only when its answer record holds
 * that agent's row of this close with the record's digest and that comment's
 * digest (its `choice_digest`, null for none), and the words, session and time
 * keys are that record's. So a comment that a local writer adds as the cited
 * agent just before the close is never shown under the cited heading. Null for
 * an item that is no cited answer (`citedAnswerer`) or has no close time.
 */
export function citeCheckBody(bead: Bead, humanActor: string): CiteCheckBody | null {
  const citedBy = citedAnswerer(bead);
  if (citedBy === null || !bead.closed_at) return null;
  const cite: Record<string, string> = {};
  for (const key of [REVIEW_CITE_SESSION_KEY, REVIEW_CITE_TYPED_AT_KEY, REVIEW_CITE_WORDS_KEY, REVIEW_CITE_RECORD_KEY]) {
    const value = bead.metadata?.[key];
    if (typeof value === "string") cite[key] = value;
  }
  const answer = latestAnswer(bead, humanActor, citedBy);
  const shown = answer && answer.author === citedBy ? commentDigest(answer.text) : null;
  return { id: bead.id, close_reason: bead.close_reason ?? "", closed_at: bead.closed_at, review_by: citedBy, comment_sha256: shown, cite };
}

/**
 * The answer that a To Review row shows: a manager's answer as `managerAnswer`
 * gives it, or the cited agent's answer with its cite (the session, the UTC time
 * and the words, from the item's cite keys, as they are: bd metadata that any
 * local writer can set). The row names them as the operator's words only when
 * the host's cite check (`citeCheckBody`) answers bound. A comment-less cited
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
