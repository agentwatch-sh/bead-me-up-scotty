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
 *     only when the project has a GitHub remote.
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
const ISSUE_RE = /(^|[^A-Za-z0-9_&#\/.-])#([1-9]\d{0,8})(?![A-Za-z0-9_])/g;
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

/**
 * The references in one run of plain text, in order, never overlapping. A
 * path to ask about is added to `unknown` (at most MAX_PATHS_PER_TEXT of
 * them): a path whose existence is not known yet (plain text for now), and a
 * path whose answer is stale (`isStale`; its old answer still shows).
 */
export function findRefs(text: string, ctx: RefContext, unknown?: Set<string>): Ref[] {
  if (typeof text !== "string" || !text) return [];
  const found: Candidate[] = [];
  const github = ctx.github;
  const isBead = ctx.isBead ?? null;

  if (github) {
    collect(QUALIFIED_ISSUE_RE, text, (m, start) => {
      const owner = m[2];
      const repo = m[3];
      if (!OWNER_RE.test(owner) || owner.endsWith("-") || repo === "." || repo === "..") return;
      found.push({ kind: "issue", start, end: start + m[0].length - m[1].length, priority: PRIORITY.qualified,
        href: `https://github.com/${owner}/${repo}/issues/${m[4]}` });
    });
    collect(SHA_RE, text, (m, start) => {
      const sha = m[2];
      if (!/[0-9]/.test(sha) || !/[a-f]/.test(sha)) return;
      found.push({ kind: "commit", start, end: start + sha.length, priority: PRIORITY.commit,
        href: `https://github.com/${github.owner}/${github.repo}/commit/${sha}` });
    });
    collect(ISSUE_RE, text, (m, start) => {
      found.push({ kind: "issue", start, end: start + 1 + m[2].length, priority: PRIORITY.issue,
        href: `https://github.com/${github.owner}/${github.repo}/issues/${m[2]}` });
    });
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
export function wholeRef(text: string, ctx: RefContext, unknown?: Set<string>): Ref | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const refs = findRefs(trimmed, ctx, unknown);
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

function splitText(value: string, ctx: RefContext, unknown?: Set<string>): MdNode[] | null {
  const refs = findRefs(value, ctx, unknown);
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

function walk(node: MdNode, ctx: RefContext, unknown?: Set<string>) {
  const children = node.children;
  if (!children || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string") {
      const parts = splitText(child.value, ctx, unknown);
      if (parts) next.push(...parts);
      else next.push(child);
    } else if (child.type === "inlineCode" && typeof child.value === "string") {
      const ref = wholeRef(child.value, ctx, unknown);
      next.push(ref ? linkNode(ref, [child]) : child);
    } else {
      walk(child, ctx, unknown);
      next.push(child);
    }
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
