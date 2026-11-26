/**
 * References to repo items in board text: which runs of text become links.
 *
 * Pure: no DOM, no network, no imports, so it runs in the browser, on the
 * server and in `node` tests alike. The caller supplies what only it knows
 * (the RefContext): the project's GitHub repo, which paths are files of the
 * checkout, the link of a path, and the item ids of this board.
 *
 * The rules (agentwatch board age-62v):
 *  1. A repo-relative file path, with an optional `:LINE`, `~LINE` or
 *     `:LINE:COL`, links to `fileHref` — only when `isFile` says the checkout
 *     holds that file (no dead links). The path rule is the agentwatch
 *     terminal's (`terminal-paths.js`): no absolute path, no `..`, no empty
 *     segment, no key store (`.ssh`, `.gnupg`), never part of a URL, and a
 *     dot or a slash in the token.
 *  2. A commit SHA (7 to 40 lower-case hex characters, at least one digit and
 *     one letter, a whole word), `#N` and `owner/repo#N` link to GitHub —
 *     only when the project has a GitHub remote. `#N` links into the repo
 *     that the words right before it name (see issueMarks): the project's
 *     repo when no word names another repo, another repo of the same owner
 *     when the word is a repo name no English word has
 *     (`self-hosted-runner PR #13`), and no link when the word may name
 *     another repo but may also be English (`step #3`, `provisioner PR #4`).
 *  3. An item id of this board links to that item.
 *
 * No lookbehind in any pattern: older Safari cannot parse it.
 */

export interface RefTarget {
  path: string;
  line: number | null;
  column: number | null;
}

export interface RefContext {
  /** The project's GitHub repo, or null: then no commit or issue links. */
  github: { owner: string; repo: string } | null;
  /** True: a file of the checkout. False: not one. Undefined: not known yet. */
  isFile?: ((path: string) => boolean | undefined) | null;
  /** True when the answer about a path is too old: the path is asked again (the old answer still shows). */
  isStale?: ((path: string) => boolean) | null;
  /** The link of a path, or null: then no path links. */
  fileHref?: ((target: RefTarget) => string | null) | null;
  /** True for an item id of this board. */
  isBead?: ((id: string) => boolean) | null;
  /** The link of an item of this board. */
  beadHref?: ((id: string) => string) | null;
}

export type RefKind = "path" | "commit" | "issue" | "bead";

export interface Ref {
  kind: RefKind;
  /** Indices into the text: the run [start, end) is the link text. */
  start: number;
  end: number;
  href: string;
  /** The item id, for a board item. */
  id?: string;
}

/** Most paths one text asks about: a long list must not become a long request. */
export const MAX_PATHS_PER_TEXT = 50;
/** Longest path considered (the terminal's limit). */
export const MAX_PATH_LENGTH = 300;
const MIN_PATH_LENGTH = 3;
/** Key stores a link never reaches into, at any depth (the terminal's list). */
const SENSITIVE_DIRS = new Set([".ssh", ".gnupg"]);

// A run a repo path is built from, with an optional `:line[:col]` or `~line`.
const RUN_RE = /[A-Za-z0-9_.+\-/]+(?::\d{1,7}(?::\d{1,7})?|~\d{1,7})?/g;
// Any scheme followed by `//`: a URL is never a path.
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;
const NUMERIC_RE = /^[\d.+-]+$/;
// Leading sentence punctuation; a single dot that starts a name stays.
const LEADING_PUNCT_RE = /^(?:[-+]|\.{2,}|\.(?![A-Za-z0-9_/]))+/;

// Characters that make a hex run, an issue mark or an id part of a longer token.
const SHA_RE = /(^|[^A-Za-z0-9_.\/@#-])([0-9a-f]{7,40})(?![A-Za-z0-9_\/-]|\.[A-Za-z0-9])/g;
// An issue mark: `#` and a whole number. The text before it decides its repo.
const HASH_RE = /#([1-9]\d{0,8})(?![A-Za-z0-9_])/g;
const QUALIFIED_ISSUE_RE =
  /(^|[^A-Za-z0-9_.\/-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9]\d{0,8})(?![A-Za-z0-9_])/g;
const BEAD_RE = /(^|[^A-Za-z0-9_.\/#-])([A-Za-z0-9][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+(?:\.\d+)*)(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

const PRIORITY: Record<RefKind | "qualified", number> = { qualified: 0, path: 1, bead: 2, commit: 3, issue: 4 };

interface Candidate extends Ref {
  priority: number;
}

/** "owner/repo" from the board's provider, checked; anything else is null. */
export function parseGithubSlug(slug: unknown): { owner: string; repo: string } | null {
  if (typeof slug !== "string") return null;
  const parts = slug.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/**
 * True for a link the board may render from a reference: https, or a path on
 * this origin. Never `//host`, a backslash, or another scheme.
 */
export function isSafeRefHref(href: string): boolean {
  if (typeof href !== "string" || !href) return false;
  if (/^https:\/\/[^/\\\s]+(?:[/?#][^\s]*)?$/i.test(href)) return true;
  return href.startsWith("/") && !href.startsWith("//") && !href.includes("\\") && !/\s/.test(href);
}

/**
 * Fill a file-link template: `{path}`, `{line}` and `{column}` become their
 * percent-encoded values (an empty string for no line or column). The result
 * must be a safe link (see isSafeRefHref), else null.
 */
export function fillFileLink(template: string, target: RefTarget): string | null {
  if (typeof template !== "string" || !template) return null;
  const value = (v: string | number | null) => (v === null || v === undefined ? "" : encodeURIComponent(String(v)));
  const href = template
    .replace(/\{path\}/g, value(target.path))
    .replace(/\{line\}/g, value(target.line))
    .replace(/\{column\}/g, value(target.column));
  return isSafeRefHref(href) ? href : null;
}

/**
 * A token as a repo-relative path, or null when it cannot safely be one.
 * `./x` and `x` are the same file. A single segment needs an extension or a
 * leading dot (`README.md`, `.env`); a bare word is never a path.
 */
export function toRepoPath(token: string): string | null {
  if (typeof token !== "string") return null;
  let rel = token;
  if (rel.startsWith("/") || rel.startsWith("~")) return null;
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (!rel || rel.endsWith("/")) return null;
  if (rel.length > MAX_PATH_LENGTH || rel.length < MIN_PATH_LENGTH) return null;
  const segments = rel.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return null;
    if (SENSITIVE_DIRS.has(seg.toLowerCase())) return null;
    if (/^\.{3,}/.test(seg) || seg.includes("...")) return null;
  }
  if (NUMERIC_RE.test(rel)) return null;
  const base = segments[segments.length - 1];
  const dot = base.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < base.length - 1;
  const isDotfile = base.length > 1 && base.startsWith(".");
  if (segments.length === 1 && !hasExtension && !isDotfile) return null;
  return rel;
}

function splitLineSuffix(token: string): RefTarget {
  const colon = /^(.+?):(\d{1,7})(?::(\d{1,7}))?$/.exec(token);
  if (colon) return { path: colon[1], line: Number(colon[2]) || null, column: colon[3] ? Number(colon[3]) || null : null };
  const tilde = /^(.+?)~(\d{1,7})$/.exec(token);
  if (tilde) return { path: tilde[1], line: Number(tilde[2]) || null, column: null };
  return { path: token, line: null, column: null };
}

function urlSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** Every path-shaped run in `text`, with its line and column; existence is not decided here. */
export function pathCandidates(text: string): Array<RefTarget & { start: number; end: number }> {
  if (typeof text !== "string" || !text) return [];
  const skip = urlSpans(text);
  const out: Array<RefTarget & { start: number; end: number }> = [];
  RUN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RUN_RE.exec(text)) !== null) {
    let raw = m[0];
    let start = m.index;
    const lead = raw.length - raw.replace(LEADING_PUNCT_RE, "").length;
    raw = raw.slice(lead);
    start += lead;
    raw = raw.replace(/[-+.]+$/, "");
    if (!raw) continue;
    const end = start + raw.length;
    if (skip.some(([s, e]) => start < e && end > s)) continue;
    // The run must stand alone: not glued to a scheme, a home or an issue mark.
    const before = start > 0 ? text[start - 1] : "";
    const after = end < text.length ? text[end] : "";
    if (before === "~" || before === ":" || before === "@" || after === "#" || after === "@") continue;
    const target = splitLineSuffix(raw);
    if (!target.path.includes("/") && !target.path.includes(".")) continue;
    const path = toRepoPath(target.path);
    if (!path) continue;
    out.push({ ...target, path, start, end });
  }
  return out;
}

function collect(re: RegExp, text: string, each: (m: RegExpExecArray, start: number) => void) {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  // The lookahead at each pattern's end consumes nothing, so the character
  // after one match is free to be the prefix of the next.
  while ((m = re.exec(text)) !== null) each(m, m.index + m[1].length);
}

// ---------------------------------------------------------------------------
// Which repo an issue mark `#N` is in: the words right before it say.
// ---------------------------------------------------------------------------
// GitHub links every `#N` into the repo it is written in. Board text names
// other repos too (`self-hosted-runner PR #13` on a daily-standup board), so
// a mark links into the board's repo only when no word before it may name
// another repo. The word is the one right before the mark, glued
// (`name#13`) or after spaces, with one keyword between them (`PR`, `pull`,
// `pull request`, `issue`, `bug`, `ticket`; any case, also plural):
//  - no word (the start, or punctuation: `(#13)`, `done. #13`, `see: #13`),
//    a number, a commit, an item id of this board, an `@mention`, or the
//    board repo's own name (any case): the board's repo;
//  - a word that leads into a reference (LEAD_WORDS: `fixes #9`, `see #12`,
//    `and #3`, `tested PR #4`), or, before a keyword, a determiner, a number
//    word or an adjective (ITEM_WORDS: `the PR #4`, `two PRs #5 and #6`):
//    the board's repo, unless an unmistakable repo name stands up to two
//    such words further back (lookBack): behind determiners and adjectives
//    only it owns the mark (`self-hosted-runner draft PR #13`,
//    `self-hosted-runner merged #13`); behind a verb or a preposition the
//    mark may be in either repo, so no link (`self-hosted-runner approved PR
//    #13`, `self-hosted-runner: fixed in #13`);
//  - an unmistakable repo name (otherRepoName: three or more parts joined by
//    `-`, `self-hosted-runner`, `code-review-bot`): that repo of the board
//    repo's owner. A wrong guess (a repo of another owner) most often ends
//    on GitHub's 404 page. `owner/repo` names that repo when the owner is the
//    board repo's owner, or when the owner (`MarketData-App`,
//    `AsyncAlchemist`) and the repo are both no English word, acronym or
//    folder: never `CI/CD PR #12`, `packages/web-client #12` or `and/or #3`;
//  - an unmistakable repo name or `owner/repo` behind punctuation
//    (`self-hosted-runner (#13)`, `self-hosted-runner: #13`): no link, as the
//    mark may be in that repo (`feat: a thing (#13)` stays the board's). A
//    keyword behind punctuation reads on (`self-hosted-runner PR: #13`);
//  - any other word: no link. An English word (`step #3`, `the #1`,
//    `dark-mode PR #7`) and a repo name of one or two parts
//    (`provisioner PR #4`, `daily-standup #5`) look the same, and plain text
//    never sends the reader to a wrong item.
// A mark after another one with only `,`, `and`, `or` or `&` (and a keyword)
// between them is in the same repo: `self-hosted-runner PRs #13 and #14`.

type GithubRepo = { owner: string; repo: string };
/** The repo an issue mark links into; null: the mark stays text. */
type IssueRepo = GithubRepo | null;
type IsBead = ((id: string) => boolean) | null;
/** A word of the text and where it starts. */
type Word = { word: string; start: number };

const wordSet = (words: string) => new Set(words.trim().split(/\s+/));

/** Words after which `#N` (also `PR #N`) is an item of the board's repo: they lead into a reference. */
const LEAD_WORDS = wordSet(`
  about after against also and as at before but by cf despite during except for from in including into like nor of on
  onto or per plus re regarding since than then through to toward towards under until upon versus via vs with within
  without is are was were be been am has have had do does did will would can could should may might must
  see sees saw seen ref refs reference references referenced close closes closed closing fix fixes fixed fixing resolve
  resolves resolved resolving revert reverts reverted reverting supersede supersedes superseded superseding replace
  replaces replaced replacing duplicate duplicates duplicated dup dupe block blocks blocked blocking unblock unblocks
  unblocked follow follows followed following address addresses addressed implement implements implemented land lands
  landed landing merge merges merged merging open opens opened opening reopen reopens reopened reopening file files
  filed track tracks tracked tracking mention mentions mentioned link links linked relate relates related need needs
  needed require requires required depend depends update updates updated updating review reviews reviewed reviewing
  approve approves approved approving ship ships shipped shipping continue continues continued extend extends extended
  backport backports backported finish finishes finished complete completes completed cover covers covered
  tested testing pushed pushing rebased rebasing created creating deployed deploying raised raising posted posting sent
  sending submitted submitting drafted drafting wrote writing written started starting began picked picking took taking
  assigned assigning claimed claiming triaged triaging bumped bumping upgraded upgrading released releasing tagged
  tagging checked checking verified verifying confirmed confirming investigated investigating debugged debugging
  commented answered asked noted flagged reported documented discussed squashed abandoned dropped parked paused resumed
  waiting awaiting now still just only even already again here there too not
  follow-up follow-ups followup followups follow-on
`);
/** Before a keyword only: a determiner, a number word or an adjective (`the PR #4`, `two PRs #5 and #6`). */
const ITEM_WORDS = wordSet(`
  the a an this that these those my our your their his her its same each every any some no one another other which
  whose what either neither both all two three four five six several few many multiple draft new old original previous
  prior next last first second third earlier later latest current separate parent child big small large pending stale
  own above below said github gh
`);
/** Adjectives (with ITEM_WORDS) skipped to find a repo name further back: `self-hosted-runner merged PR #13`. */
const STATE_WORDS = wordSet("open opened merged closed linked related");
/** A first part, a last part or a joining part of these makes a hyphenated English word (`up-to-date`, `good-first-issue`). */
const COMPOUND_HEADS = wordSet(`
  re pre post non sub co de un ex multi cross anti auto semi mid mis inter intra meta micro mini mega ultra super over
  under out up down in on off per well ill so all half full one two three four five ten first second third last long
  short high low top real hard soft hand side big small open double single quick fast slow dry front back left right end
  opt must to do no not follow
`);
const COMPOUND_TAILS = wordSet(`
  up ups in ins on ons off offs out outs down over back by through around away only level time line lines side end based
  related specific wide free safe aware like ish ready friendly driven facing proof style type sensitive insensitive fix
  fixes term scale way ways less issue issues request requests review reviews wanted needed info bug bugs work
`);
const COMPOUND_JOINS = wordSet("to of in by and or not it the an for on at with from as per vs than into");
const ISSUE_KEYWORDS = wordSet("pr prs pull pulls pull-request pull-requests issue issues bug bugs ticket tickets");

// The space between a name, a keyword and the mark (a soft line break is a space).
const GAP_CHAR_RE = /[ \t\u00a0\r\n]/;
// A character of the word before a mark: a name, `owner/repo`, or a longer run that is neither.
const WORD_CHAR_RE = /[A-Za-z0-9._\/-]/;
// Punctuation between a repo name and a mark: `name (#13)`, `name: #13`, `name - #13`.
const PUNCT_CHAR_RE = /[()[\]:,;\u2013\u2014-]/;
/** Longest word read before a mark; a longer run is no name. */
const MAX_WORD_LENGTH = 200;
/** Most characters of the text before a run (the Markdown nodes before it) read for a name. */
const MAX_LEAD_LENGTH = 300;
// What may stand between two marks of one list: `#13, #14`, `#13 and PR #14`.
const LIST_GAP_RE =
  /^[ \t\u00a0\r\n]*(?:,[ \t\u00a0\r\n]*(?:(?:and|or)[ \t\u00a0\r\n]+)?|(?:and|or|&)[ \t\u00a0\r\n]+)?(?:(?:prs?|pulls?|pull[ \t\u00a0\r\n]+requests?|issues?)[ \t\u00a0\r\n]+)?$/i;
const NAME_SHAPE_RE = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;
const SLUG_REPO_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * True for a repo name that no English word has: a letter first, then three
 * or more parts joined by `-`, each of two or more characters with a letter,
 * no digit in the last part (an item id, a version), no dot (a file,
 * `next.js`), no underscore (an identifier, `get_user_id`), and no
 * hyphenated English word (`up-to-date`, `good-first-issue`). Two parts are
 * as often English (`dark-mode`, `tech-debt`, `help-wanted`) as a repo name.
 */
function otherRepoName(name: string): boolean {
  if (name.length > 100 || !NAME_SHAPE_RE.test(name)) return false;
  const parts = name.toLowerCase().split("-");
  if (parts.length < 3 || parts.some((part) => part.length < 2 || !/[a-z]/.test(part))) return false;
  if (/\d/.test(parts[parts.length - 1])) return false;
  return !(COMPOUND_HEADS.has(parts[0]) || COMPOUND_TAILS.has(parts[parts.length - 1])
    || parts.slice(1, -1).some((part) => COMPOUND_JOINS.has(part)));
}

/**
 * True for an owner that is no English word, acronym or folder: a lower-case
 * letter, and a dash or an inner capital (`MarketData-App`, `AsyncAlchemist`,
 * `brendan-appstart`; never `CI` of `CI/CD`).
 */
function ownerName(owner: string): boolean {
  return /[a-z]/.test(owner) && (owner.includes("-") || /[A-Z]/.test(owner.slice(1)));
}

/**
 * The repo that a name certainly is, else undefined: the board repo's own
 * name, an unmistakable repo name (of the board repo's owner), or
 * `owner/repo` with the board repo's owner, or with an owner (ownerName) and
 * a repo (otherRepoName) that no English word, acronym or folder has.
 */
function namedRepo(name: string, github: GithubRepo): GithubRepo | undefined {
  if (name.includes("/")) {
    const parts = name.split("/");
    if (parts.length !== 2) return undefined;
    const [owner, repo] = parts;
    if (!OWNER_RE.test(owner) || owner.endsWith("-") || !SLUG_REPO_RE.test(repo)) return undefined;
    if (owner.toLowerCase() === github.owner.toLowerCase()) {
      return repo.toLowerCase() === github.repo.toLowerCase() ? github : { owner, repo };
    }
    return ownerName(owner) && otherRepoName(repo) ? { owner, repo } : undefined;
  }
  if (name.toLowerCase() === github.repo.toLowerCase()) return github;
  return otherRepoName(name) ? { owner: github.owner, repo: name } : undefined;
}

/** Leading dots (`...name`) go; a leading dash (`--flag`) and a leading slash (an absolute path) stay: no name. */
const cleanWord = (word: string) => word.replace(/^\.+/, "");

/** True for a word that may stand between a repo name and a mark: a lead-in word, a determiner or an adjective. */
const leadIn = (lower: string) => LEAD_WORDS.has(lower) || ITEM_WORDS.has(lower) || STATE_WORDS.has(lower);

/** Where the spaces that end at `end` start. */
function gapStart(text: string, end: number): number {
  let i = end;
  while (i > 0 && GAP_CHAR_RE.test(text[i - 1])) i -= 1;
  return i;
}

/** The word that ends at `end` (a closing quote or a possessive `'s` after it is dropped), or null. */
function wordBefore(text: string, end: number): Word | null {
  let e = end;
  if (e >= 2 && /['"\u2019\u201d]/.test(text[e - 1]) && WORD_CHAR_RE.test(text[e - 2])) e -= 1;
  else if (e >= 3 && /s/i.test(text[e - 1]) && /['\u2019]/.test(text[e - 2]) && WORD_CHAR_RE.test(text[e - 3])) e -= 2;
  let s = e;
  while (s > 0 && e - s < MAX_WORD_LENGTH && WORD_CHAR_RE.test(text[s - 1])) s -= 1;
  return s < e ? { word: text.slice(s, e), start: s } : null;
}

/** The word before the spaces that end at `end`, or null (no spaces, or punctuation before them). */
function wordBeforeGap(text: string, end: number): Word | null {
  const at = gapStart(text, end);
  return at < end ? wordBefore(text, at) : null;
}

/** True for a word that is punctuation only: `-`, `--`, `...`. */
const punctOnly = (word: string) => /^[._-]+$/.test(word);

/** The repo that the word before a mark names; `keyword`: a `PR` or an `issue` stands between them. */
function wordRepo(text: string, w: Word, keyword: boolean, github: GithubRepo, isBead: IsBead): IssueRepo {
  const name = cleanWord(w.word);
  // A number, or a word that punctuation ends (`done.`): no name.
  if (!/[A-Za-z]/.test(name) || !/[A-Za-z0-9]$/.test(name)) return github;
  // A person (`@alice PR #14`), a commit or an item of this board, listed before the mark.
  if (w.start > 0 && text[w.start - 1] === "@") return github;
  if ((/^[0-9a-f]{7,40}$/.test(name) && /[0-9]/.test(name) && /[a-f]/.test(name)) || isBead?.(name)) return github;
  const named = namedRepo(name, github);
  if (named) return named;
  const lower = name.toLowerCase();
  if (!name.includes("/") && (LEAD_WORDS.has(lower) || (keyword && ITEM_WORDS.has(lower)))) return github;
  return null;
}

/** The keyword that `w` is (`PR`, `issue`; the `pull` of `pull request`), or null. */
function keywordAt(text: string, w: Word): Word | null {
  if (/^requests?$/i.test(w.word)) {
    const pull = wordBeforeGap(text, w.start);
    return pull && /^pull$/i.test(pull.word) ? pull : null;
  }
  return ISSUE_KEYWORDS.has(w.word.toLowerCase()) ? w : null;
}

// The functions below read backwards from a mark. `depth` counts the steps
// over punctuation: at most two, so a long run of `PR (PR (...` stays cheap.

/**
 * The repo of a mark with punctuation right before it, at `at` (`(#13)`,
 * `see: #13`, the start). A keyword behind the punctuation is read as before
 * a space (`self-hosted-runner PR: #13` is that repo's). Else the board's
 * repo, unless an unmistakable repo name or `owner/repo` stands behind the
 * punctuation (`self-hosted-runner (#13)`): then no link.
 */
function behindPunctuation(text: string, at: number, github: GithubRepo, isBead: IsBead, depth: number): IssueRepo {
  let p = at;
  while (p > 0 && at - p < 3 && PUNCT_CHAR_RE.test(text[p - 1])) p -= 1;
  if (p === at || depth >= 2) return github;
  const w = wordBefore(text, gapStart(text, p));
  if (!w) return github;
  const keyword = keywordAt(text, w);
  if (keyword) return repoBeforeKeyword(text, keyword, github, isBead, depth + 1);
  const named = namedRepo(cleanWord(w.word), github);
  return named && named !== github ? null : github;
}

/**
 * The repo of a mark after `w`, a lead-in word, a determiner or an
 * adjective, read further back over at most two such words. An unmistakable
 * repo name there owns the mark when only determiners and adjectives stand
 * between (`self-hosted-runner draft PR #13`, `self-hosted-runner merged
 * #13`). With a lead-in verb or preposition between
 * (`self-hosted-runner approved PR #13`, `self-hosted-runner: fixed in #13`)
 * the mark may be in either repo: no link. Else the board's repo.
 */
function lookBack(text: string, w: Word, github: GithubRepo, isBead: IsBead, depth: number): IssueRepo {
  let cur = w;
  let adjectives = true;
  for (let i = 0; i < 2; i += 1) {
    const lower = cleanWord(cur.word).toLowerCase();
    if (!leadIn(lower)) return github;
    if (!ITEM_WORDS.has(lower) && !STATE_WORDS.has(lower)) adjectives = false;
    const back = wordBeforeGap(text, cur.start);
    if (!back || punctOnly(back.word)) {
      // Punctuation: a repo name behind it (`self-hosted-runner, the PR #13`) may own the mark.
      return behindPunctuation(text, gapStart(text, cur.start), github, isBead, depth + 1) === github ? github : null;
    }
    const named = namedRepo(cleanWord(back.word), github);
    if (named) return named === github || adjectives ? named : null;
    cur = back;
  }
  return github;
}

/** The repo that `w`, the word before a mark (or before its keyword), names; a lead-in word is read further back. */
function repoOfWord(text: string, w: Word, keyword: boolean, github: GithubRepo, isBead: IsBead, depth: number): IssueRepo {
  const repo = wordRepo(text, w, keyword, github, isBead);
  return repo === github && leadIn(cleanWord(w.word).toLowerCase()) ? lookBack(text, w, github, isBead, depth) : repo;
}

/** The repo of a mark after a keyword (`PR`, `issue`): the word before the keyword says. */
function repoBeforeKeyword(text: string, keyword: Word, github: GithubRepo, isBead: IsBead, depth: number): IssueRepo {
  const at = gapStart(text, keyword.start);
  const name = at < keyword.start ? wordBefore(text, at) : null;
  if (!name || punctOnly(name.word)) return behindPunctuation(text, at, github, isBead, depth);
  return repoOfWord(text, name, true, github, isBead, depth);
}

/** The repo of the mark at `hash`, which follows a space, punctuation or the start. */
function repoBeforeSpace(text: string, hash: number, github: GithubRepo, isBead: IsBead): IssueRepo {
  const at = gapStart(text, hash);
  const w = at < hash ? wordBefore(text, at) : null;
  if (!w || punctOnly(w.word)) return behindPunctuation(text, at, github, isBead, 0);
  const keyword = keywordAt(text, w);
  return keyword ? repoBeforeKeyword(text, keyword, github, isBead, 0) : repoOfWord(text, w, false, github, isBead, 0);
}

/**
 * The repo of a mark glued to a name (`self-hosted-runner#13`), and where
 * the link starts. A name in the Markdown node before (before `offset`:
 * `**Fixed**#13`) is read as a word before a space, and only the mark links.
 */
function repoGlued(text: string, hash: number, offset: number, github: GithubRepo, isBead: IsBead): { start: number; repo: IssueRepo } {
  let s = hash;
  while (s > 0 && hash - s < MAX_WORD_LENGTH && /[A-Za-z0-9._-]/.test(text[s - 1])) s -= 1;
  // Part of a slug (`owner/repo#N` is the qualified rule's), a path, a mention or a longer run.
  if (s > 0 && /[A-Za-z0-9._\/@-]/.test(text[s - 1])) return { start: s, repo: null };
  const word: Word = { word: text.slice(s, hash), start: s };
  if (s < offset) return { start: hash, repo: repoOfWord(text, word, false, github, isBead, 0) };
  if (isBead?.(word.word) || !/^[A-Za-z0-9]/.test(word.word)) return { start: s, repo: null };
  return { start: s, repo: namedRepo(word.word, github) ?? null };
}

/** The repo of an `owner/repo#N` match of QUALIFIED_ISSUE_RE, or null. */
function qualifiedRepo(m: RegExpExecArray): GithubRepo | null {
  const owner = m[2];
  const repo = m[3];
  if (!OWNER_RE.test(owner) || owner.endsWith("-") || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/**
 * The `#N` marks of `text` that link. `lead` is the text right before `text`
 * (the Markdown nodes before it), read only for the words before a mark and
 * for a list that started there (`**self-hosted-runner PR #13** and #14`).
 */
function issueMarks(text: string, lead: string, github: GithubRepo, isBead: IsBead): Candidate[] {
  const before = lead.slice(-MAX_LEAD_LENGTH);
  const full = before + text;
  const offset = before.length;
  const urls = urlSpans(full);
  // The `owner/repo#N` marks, by their end: the qualified rule links them, and a list goes on in their repo.
  const qualified = new Map<number, { start: number; repo: GithubRepo }>();
  collect(QUALIFIED_ISSUE_RE, full, (m, start) => {
    const repo = qualifiedRepo(m);
    if (repo) qualified.set(start + m[0].length - m[1].length, { start, repo });
  });
  const out: Candidate[] = [];
  let prev: { end: number; repo: IssueRepo } | null = null;
  let url = 0;
  HASH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HASH_RE.exec(full)) !== null) {
    const hash = m.index;
    const end = hash + m[0].length;
    // The marks come in order, and so do the URLs.
    while (url < urls.length && urls[url][1] <= hash) url += 1;
    if (url < urls.length && urls[url][0] <= hash) continue;
    const named = qualified.get(end);
    if (named) {
      prev = { end, repo: named.repo };
      // `owner/repo` in the node before (`` `owner/repo`#13 ``): the qualified rule reads only this text, so the mark links here.
      if (named.start < offset && hash >= offset) {
        out.push({ kind: "issue", start: hash - offset, end: end - offset, priority: PRIORITY.issue,
          href: `https://github.com/${named.repo.owner}/${named.repo.repo}/issues/${m[1]}` });
      }
      continue;
    }
    const ch = hash > 0 ? full[hash - 1] : "";
    let start = hash;
    let repo: IssueRepo;
    if (/[A-Za-z0-9]/.test(ch)) {
      const glued = repoGlued(full, hash, offset, github, isBead);
      start = glued.start;
      repo = glued.repo;
    } else if (/[_&#\/.-]/.test(ch)) {
      continue; // `x/#12`, `&#38;`, `##12`: part of a longer token
    } else {
      const gap: string = prev ? full.slice(prev.end, hash) : "";
      repo = prev && gap && gap.length <= 40 && LIST_GAP_RE.test(gap) ? prev.repo : repoBeforeSpace(full, hash, github, isBead);
    }
    prev = { end, repo };
    if (!repo || hash < offset) continue;
    out.push({ kind: "issue", start: start - offset, end: end - offset, priority: start < hash ? PRIORITY.qualified : PRIORITY.issue,
      href: `https://github.com/${repo.owner}/${repo.repo}/issues/${m[1]}` });
  }
  return out;
}

/**
 * The references in one run of plain text, in order, never overlapping. A
 * path to ask about is added to `unknown` (at most MAX_PATHS_PER_TEXT of
 * them): a path whose existence is not known yet (plain text for now), and a
 * path whose answer is stale (`isStale`; its old answer still shows).
 * `before` is the text right before this run (in Markdown, the inline nodes
 * before it: inline code, bold, a link), read only for the words before an
 * issue mark: `` `self-hosted-runner` PR #13 ``.
 */
export function findRefs(text: string, ctx: RefContext, unknown?: Set<string>, before = ""): Ref[] {
  if (typeof text !== "string" || !text) return [];
  const found: Candidate[] = [];
  const github = ctx.github;
  const isBead = ctx.isBead ?? null;

  if (github) {
    collect(QUALIFIED_ISSUE_RE, text, (m, start) => {
      const repo = qualifiedRepo(m);
      if (!repo) return;
      found.push({ kind: "issue", start, end: start + m[0].length - m[1].length, priority: PRIORITY.qualified,
        href: `https://github.com/${repo.owner}/${repo.repo}/issues/${m[4]}` });
    });
    collect(SHA_RE, text, (m, start) => {
      const sha = m[2];
      if (!/[0-9]/.test(sha) || !/[a-f]/.test(sha)) return;
      found.push({ kind: "commit", start, end: start + sha.length, priority: PRIORITY.commit,
        href: `https://github.com/${github.owner}/${github.repo}/commit/${sha}` });
    });
    found.push(...issueMarks(text, typeof before === "string" ? before : "", github, isBead));
  }

  if (isBead && ctx.beadHref) {
    const beadHref = ctx.beadHref;
    collect(BEAD_RE, text, (m, start) => {
      const id = m[2];
      if (!isBead(id)) return;
      found.push({ kind: "bead", start, end: start + id.length, priority: PRIORITY.bead, href: beadHref(id), id });
    });
  }

  if (ctx.fileHref && ctx.isFile) {
    let asked = unknown ? unknown.size : 0;
    for (const c of pathCandidates(text)) {
      if (isBead && isBead(c.path)) continue;
      const exists = ctx.isFile(c.path);
      if ((exists === undefined || ctx.isStale?.(c.path)) && unknown && !unknown.has(c.path) && asked < MAX_PATHS_PER_TEXT) {
        unknown.add(c.path);
        asked += 1;
      }
      if (!exists) continue;
      const href = ctx.fileHref({ path: c.path, line: c.line, column: c.column });
      if (!href) continue;
      found.push({ kind: "path", start: c.start, end: c.end, priority: PRIORITY.path, href });
    }
  }

  found.sort((a, b) => a.start - b.start || a.priority - b.priority);
  const kept: Ref[] = [];
  let end = 0;
  for (const c of found) {
    if (c.start < end) continue;
    kept.push({ kind: c.kind, start: c.start, end: c.end, href: c.href, ...(c.id ? { id: c.id } : {}) });
    end = c.end;
  }
  return kept;
}

/** The reference that is the whole of `text` (inline code), or null. */
export function wholeRef(text: string, ctx: RefContext, unknown?: Set<string>, before = ""): Ref | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const refs = findRefs(trimmed, ctx, unknown, before);
  return refs.length === 1 && refs[0].start === 0 && refs[0].end === trimmed.length ? refs[0] : null;
}

// ---------------------------------------------------------------------------
// The remark plugin that applies the rules to Markdown.
// ---------------------------------------------------------------------------
// Only Markdown text is linked: a fenced or indented code block, raw HTML, and
// the text of a link someone wrote stay as they are. Inline code is linked when
// its whole content is one reference (`README.md:3`, `55e6b91`).
//
// Each link the plugin makes carries `data-repo-ref` (the reference kind): the
// renderer accepts an on-origin link only with that mark, so a link written in
// the text keeps the strict URL rule. No unist-util dependency: the walk below
// is the whole of it.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** Parents whose content is never linked. */
const SKIP = new Set(["code", "html", "link", "linkReference", "definition", "inlineMath", "math", "yaml"]);

function linkNode(ref: Ref, children: MdNode[]): MdNode {
  const hProperties: Record<string, unknown> = { dataRepoRef: ref.kind };
  if (ref.id) hProperties.dataBeadId = ref.id;
  return { type: "link", url: ref.href, children, data: { hProperties } };
}

/** Inline nodes whose text can hold the name before an issue mark in the text after them. */
const INLINE_TEXT = new Set(["text", "inlineCode", "emphasis", "strong", "delete", "link", "linkReference"]);

function inlineText(node: MdNode): string {
  if (!INLINE_TEXT.has(node.type)) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(inlineText).join("");
}

function splitText(value: string, ctx: RefContext, unknown?: Set<string>, before = ""): MdNode[] | null {
  const refs = findRefs(value, ctx, unknown, before);
  if (refs.length === 0) return null;
  const out: MdNode[] = [];
  let at = 0;
  for (const ref of refs) {
    if (ref.start > at) out.push({ type: "text", value: value.slice(at, ref.start) });
    out.push(linkNode(ref, [{ type: "text", value: value.slice(ref.start, ref.end) }]));
    at = ref.end;
  }
  if (at < value.length) out.push({ type: "text", value: value.slice(at) });
  return out;
}

/**
 * `lead`: the text of the inline nodes before `node` in its paragraph, so
 * that `` `self-hosted-runner` PR #13 `` and `self-hosted-runner PR **#13**`
 * name the repo across nodes. A block starts with none.
 */
function walk(node: MdNode, ctx: RefContext, unknown?: Set<string>, lead = "") {
  const children = node.children;
  if (!children || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  let before = lead;
  for (const child of children) {
    const inline = INLINE_TEXT.has(child.type);
    if (child.type === "text" && typeof child.value === "string") {
      const parts = splitText(child.value, ctx, unknown, before);
      if (parts) next.push(...parts);
      else next.push(child);
    } else if (child.type === "inlineCode" && typeof child.value === "string") {
      const ref = wholeRef(child.value, ctx, unknown, before);
      next.push(ref ? linkNode(ref, [child]) : child);
    } else {
      walk(child, ctx, unknown, inline ? before : "");
      next.push(child);
    }
    // A block, a line break or an image ends the run of inline text.
    before = inline ? (before + inlineText(child)).slice(-MAX_LEAD_LENGTH) : "";
  }
  node.children = next;
}

export interface RemarkRepoRefsOptions {
  ctx: RefContext;
  /** Receives the paths to ask about: not known yet, or known from a stale answer. */
  unknown?: Set<string>;
}

export function remarkRepoRefs(options: RemarkRepoRefsOptions) {
  return (tree: MdNode) => {
    if (!options?.ctx) return;
    walk(tree, options.ctx, options.unknown);
  };
}

// ---------------------------------------------------------------------------
// The provider: where the board learns the GitHub repo, the file link and
// which paths are files.
// ---------------------------------------------------------------------------
// A host (agentwatch) names one URL per project in the board's meta
// (`repoRefsUrl`). `GET <url>` answers `{github, file_link, files}`, and
// `GET <url>?path=a&path=b` also says which of the asked paths are files of the
// checkout. Without a URL the board links only its own item ids.
//
// One source per URL: one context fetch, path checks batched into requests of
// at most MAX_PATHS_PER_TEXT. A path answer is fresh for REFS_TTL_MS. The
// renderer collects the paths of the text it renders that have no answer, or
// whose answer is older than REFS_TTL_MS (isStale), and asks for them after
// the render: so a stale path is asked again at the next render of a text
// that names it. A stale answer still shows while it is asked again, so a
// link does not blink. A failed request changes nothing that is known; a path
// never answered stays plain.
//
// The renderer calls request() after every render, and an answer that
// changes something renders again. So a failure must never render, and a
// path whose check failed waits a backoff (retryDelay) before it is asked
// again: else a gateway restart, a 401 or a 502 would ask the same path in a
// loop. A path batch answered with no file link (the provider's no-links
// answer, its daemon gone for now) counts as a failure: the context and the
// answers stay. Paths are collected only once the context has a file link
// (sourceRefContext), so a provider that never answered is asked no path.
//
// The context is asked once when the source is made. A failed context (an
// error status, no answer) and a context with no file link and no GitHub repo
// (the provider's no-links answer: a gateway restart, the user's daemon not
// back yet) is a failure with the same backoff: request(), which the renderer
// calls after every render also when it collected no path, asks the context
// again once its backoff has passed. A context that answered is not asked
// again during the page's life.
//
// The provider may leave `github` out of a path batch answer (it reads the
// remotes only for the context): then the known repo stays.

/** How long a path answer is fresh. */
export const REFS_TTL_MS = 60_000;
/** The wait after a path's (or the context's) first failed check; it doubles after each further failure, up to REFS_TTL_MS. */
export const REFS_RETRY_MS = 5_000;

/** How long a path, or the context, waits after its `failures`-th failed check in a row before it is asked again. */
export function retryDelay(failures: number): number {
  return Math.min(REFS_TTL_MS, REFS_RETRY_MS * 2 ** Math.max(0, failures - 1));
}

type Fetcher = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface RefsSourceOptions {
  fetcher: Fetcher;
  now?: () => number;
  /** Run the batch later (a timer in the browser; the tests call it by hand). */
  schedule?: (fn: () => void) => void;
}

export class RefsSource {
  readonly url: string;
  github: { owner: string; repo: string } | null = null;
  fileLink: string | null = null;
  /** Settles after the first context answer (or its failure). */
  readonly ready: Promise<void>;
  /** True once a context answered with a file link or a GitHub repo: it is not asked again. */
  private contextKnown = false;
  private askingContext = false;
  /** Failed context answers in a row, and the time of the last one. */
  private contextFailures: { count: number; at: number } | null = null;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void) => void;
  private readonly answers = new Map<string, { exists: boolean; at: number }>();
  /** Failed checks in a row of a path, and the time of the last one. */
  private readonly failures = new Map<string, { count: number; at: number }>();
  private readonly asking = new Set<string>();
  private queue: string[] = [];
  private scheduled = false;
  private inflight = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(url: string, options: RefsSourceOptions) {
    this.url = url;
    this.fetcher = options.fetcher;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((fn) => { setTimeout(fn, 0); });
    this.ready = this.askContext();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = (): number => this.version;

  /** True or false when answered (even if stale); undefined when never answered. */
  isFile = (path: string): boolean | undefined => this.answers.get(path)?.exists;

  /** True when the path's answer is older than REFS_TTL_MS: the renderer collects it to ask again. */
  isStale = (path: string): boolean => {
    const hit = this.answers.get(path);
    return hit !== undefined && this.now() - hit.at >= REFS_TTL_MS;
  };

  fileHref = (target: RefTarget): string | null => (this.fileLink ? fillFileLink(this.fileLink, target) : null);

  /**
   * Ask for the paths never answered or answered too long ago, unless a failed
   * check is still in its backoff. A context that failed is asked again here
   * once its backoff has passed, also when no path is given.
   */
  request(paths: Iterable<string> = []): void {
    const now = this.now();
    const failed = this.contextFailures;
    if (!this.contextKnown && !this.askingContext && failed && now - failed.at >= retryDelay(failed.count)) {
      void this.askContext();
    }
    for (const path of paths) {
      if (this.asking.has(path)) continue;
      const hit = this.answers.get(path);
      if (hit && now - hit.at < REFS_TTL_MS) continue;
      const failed = this.failures.get(path);
      if (failed && now - failed.at < retryDelay(failed.count)) continue;
      this.asking.add(path);
      this.queue.push(path);
    }
    if (this.queue.length && !this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  /** Settles when no request is in flight (for tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private flush(): void {
    this.scheduled = false;
    const queue = this.queue;
    this.queue = [];
    for (let i = 0; i < queue.length; i += MAX_PATHS_PER_TEXT) {
      this.track(this.ask(queue.slice(i, i + MAX_PATHS_PER_TEXT)));
    }
  }

  private askContext(): Promise<void> {
    this.askingContext = true;
    return this.track(this.ask([]));
  }

  private track(p: Promise<void>): Promise<void> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  private async ask(paths: string[]): Promise<void> {
    let data: Record<string, unknown> | null = null;
    try {
      const params = paths.map((p) => `path=${encodeURIComponent(p)}`).join("&");
      const url = params ? `${this.url}${this.url.includes("?") ? "&" : "?"}${params}` : this.url;
      const res = await this.fetcher(url);
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown> | null;
        const inner = body && typeof body === "object" && body.data && typeof body.data === "object" ? body.data : body;
        data = inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
      }
    } catch {
      data = null;
    }
    const context = paths.length === 0;
    if (context) this.askingContext = false;
    for (const p of paths) this.asking.delete(p);
    const at = this.now();
    const raw = data && typeof data.file_link === "string" ? data.file_link : null;
    const link = raw && fillFileLink(raw, { path: "x", line: 1, column: 1 }) ? raw : null;
    const github = data && (context || "github" in data) ? parseGithubSlug(data.github) : undefined;
    if (!data || (!context && raw === null) || (context && link === null && github === null)) {
      // Nothing changed: no render. The context, or each path, waits its backoff.
      if (context) this.contextFailures = { count: (this.contextFailures?.count ?? 0) + 1, at };
      for (const p of paths) this.failures.set(p, { count: (this.failures.get(p)?.count ?? 0) + 1, at });
      return;
    }
    if (context) {
      this.contextKnown = true;
      this.contextFailures = null;
    }
    let changed = false;
    if (github !== undefined && (github?.owner !== this.github?.owner || github?.repo !== this.github?.repo)) {
      this.github = github;
      changed = true;
    }
    if (link !== this.fileLink) {
      this.fileLink = link;
      changed = true;
    }
    const files = new Set(Array.isArray(data.files) ? data.files.filter((f): f is string => typeof f === "string") : []);
    for (const p of paths) {
      const exists = files.has(p);
      if (this.answers.get(p)?.exists !== exists) changed = true;
      this.answers.set(p, { exists, at });
      this.failures.delete(p);
    }
    if (changed) this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/**
 * The provider's part of a RefContext. A path is checked and linked only once
 * the provider has answered with a file link: before that (no answer yet, a
 * failed one, a project with no checkout) `isFile`, `isStale` and `fileHref`
 * are null, so no path is collected and none is asked about.
 */
export function sourceRefContext(
  source: RefsSource | null | undefined,
): Pick<RefContext, "github" | "isFile" | "isStale" | "fileHref"> {
  if (!source) return { github: null, isFile: null, isStale: null, fileHref: null };
  const files = Boolean(source.fileLink);
  return {
    github: source.github,
    isFile: files ? source.isFile : null,
    isStale: files ? source.isStale : null,
    fileHref: files ? source.fileHref : null,
  };
}
