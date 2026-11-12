"use client";
import * as React from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { api } from "@/lib/api-client";
import { useOptionalApp } from "@/components/app-context";
import { withBasePath } from "@/lib/base-path";
import { RefsSource, isSafeRefHref, remarkRepoRefs, type RefContext } from "@/lib/repo-refs";

/**
 * Renders a bead description as GitHub-flavored markdown (headings, lists,
 * tables, code blocks, links, and task lists) via react-markdown + remark-gfm.
 *
 * Two bead-specific behaviors layered on top:
 *  - Image refs `![alt](attachment://<beadId>/<file>)` resolve to the
 *    attachments API; external `http(s)` images pass through.
 *  - Task-list checkboxes (`- [ ]` / `- [x]`) are interactive when `onToggleTask`
 *    is provided; toggling reports the checkbox's document-order index so the
 *    caller can rewrite the source markdown (see lib/beads-view toggleTask).
 *  - References to repo items become links (lib/repo-refs.ts): a file path of
 *    the checkout, a commit, an issue, an item of this board. The project's
 *    provider (meta.repoRefsUrl) tells which paths are files; an item link
 *    opens the item here, the others open a new tab.
 */
const IMG_PATTERN = "!\\[([^\\]]*)\\]\\((attachment:\\/\\/[^)\\s]+|https?:\\/\\/[^)\\s]+)\\)";
const SAFE_URL_PATTERN = /^(https?:|mailto:|attachment:\/\/)/i;

const INLINE_ELEMENTS = ["p", "strong", "em", "del", "code", "br", "a"];

// A link the reference plugin made (marked data-repo-ref) may also be a path
// on this origin; a link written in the text keeps the strict rule.
const safeUrlTransform: UrlTransform = (url, key, node) => {
  if (SAFE_URL_PATTERN.test(url)) return url;
  const ref = node?.properties?.dataRepoRef;
  return key === "href" && typeof ref === "string" && isSafeRefHref(url) ? url : "";
};

// One provider source per URL for the page's life: every description of a
// project shares its answers.
const sources = new Map<string, RefsSource>();

function sourceFor(url: string | null | undefined): RefsSource | null {
  if (!url || typeof window === "undefined") return null;
  let source = sources.get(url);
  if (!source) {
    source = new RefsSource(url, {
      fetcher: (u) => fetch(u, { credentials: "same-origin", headers: { Accept: "application/json" } }),
    });
    sources.set(url, source);
  }
  return source;
}

const noSubscribe = () => () => {};
const noVersion = () => 0;

/** True for a plain left click: the others keep the browser's own meaning. */
function plainClick(event: React.MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function DescriptionContent({
  text,
  projectId,
  className,
  onToggleTask,
  inline,
  plainLinks,
}: {
  text: string;
  projectId: string;
  className?: string;
  onToggleTask?: (index: number) => void;
  /** One-line use (a button label): only inline elements render; a block (table, list, heading) is unwrapped to its text. */
  inline?: boolean;
  /** Show links as plain text, for text inside a button (a link cannot nest in a button). */
  plainLinks?: boolean;
}) {
  // Fresh per render; react-markdown renders checkboxes in document order, so
  // this counter assigns each the index of its source task marker.
  const counter = { i: 0 };

  const app = useOptionalApp();
  const source = sourceFor(app?.meta?.repoRefsUrl);
  // Re-render when the provider answers.
  React.useSyncExternalStore(source?.subscribe ?? noSubscribe, source?.getVersion ?? noVersion, noVersion);
  const index = app?.index;
  const appProject = app?.projectId ?? projectId;
  const refs: RefContext = {
    github: source?.github ?? null,
    isFile: source?.isFile ?? null,
    fileHref: source?.fileHref ?? null,
    isBead: index ? (id) => index.has(id) : null,
    beadHref: (id) => withBasePath(`/p/${encodeURIComponent(appProject)}?bead=${encodeURIComponent(id)}`),
  };
  // Paths the source has not answered yet: asked for after the render.
  const unknown = new Set<string>();
  React.useEffect(() => {
    if (source && unknown.size) source.request(unknown);
  });
  const pushDetail = app?.pushDetail;

  const components: Components = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    a: ({ children, node, ...props }) => {
      const kind = (props as Record<string, unknown>)["data-repo-ref"];
      if (plainLinks) {
        // A link cannot nest in a button: a reference there is text too.
        return <span className="text-[var(--brand)] underline">{children}</span>;
      }
      const beadId = (props as Record<string, unknown>)["data-bead-id"];
      if (kind === "bead" && typeof beadId === "string" && pushDetail) {
        // An item of this board opens here, in its drawer.
        return (
          <a {...props} className="text-[var(--brand)] underline"
            onClick={(event) => {
              if (!plainClick(event)) return;
              event.preventDefault();
              pushDetail(beadId);
            }}>
            {children}
          </a>
        );
      }
      return (
        <a {...props} target="_blank" rel="noopener noreferrer" className="text-[var(--brand)] underline">
          {children}
        </a>
      );
    },
    ...(inline ? { p: ({ children }) => <span>{children}</span> } : {}),
    img: ({ src, alt }) => {
      const raw = typeof src === "string" ? src : "";
      const resolved = raw.startsWith("attachment://") ? api.attachments.urlFor(projectId, raw) : raw;
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolved}
          alt={alt ?? ""}
          className="my-2 block max-h-[320px] max-w-full rounded-[8px] border border-border"
        />
      );
    },
    // A wide table scrolls sideways inside its own box instead of pushing the
    // page wider than a phone screen (see .bd-md-table-scroll in globals.css).
    table: ({ children }) => (
      <div className="bd-md-table-scroll">
        <table>{children}</table>
      </div>
    ),
    input: ({ type, checked }) => {
      if (type !== "checkbox") return null;
      const idx = counter.i++;
      return (
        <input
          type="checkbox"
          checked={!!checked}
          disabled={!onToggleTask}
          onChange={() => onToggleTask?.(idx)}
          className="mr-[6px] translate-y-[2px] cursor-pointer disabled:cursor-default"
          style={{ accentColor: "var(--brand)" }}
        />
      );
    },
  };

  const Wrap = inline ? "span" : "div";
  return (
    <Wrap className={className}>
      <Wrap className="bd-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, [remarkRepoRefs, { ctx: refs, unknown }]]}
          // Colorize fenced code blocks; `ignoreMissing` keeps unknown languages
          // from throwing (they fall back to plain text). Themed via .hljs CSS.
          rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
          // Preserve attachment:// refs for local images, but reject executable
          // or local-file schemes when comments/descriptions render user text.
          // NB: the syntax-highlighting branch had swapped this for a pass-through
          // `(url) => url` so that attachment:// would resolve — but
          // safeUrlTransform already allows attachment://, so the swap bought
          // nothing and silently re-opened javascript:/file: URLs in rendered
          // user text. Keep the guard.
          urlTransform={safeUrlTransform}
          components={components}
          // Inline use keeps to phrasing elements, so a label stays on one line.
          // Raw HTML never renders (no rehype-raw), in either mode.
          allowedElements={inline ? INLINE_ELEMENTS : undefined}
          unwrapDisallowed={inline}
        >
          {text}
        </ReactMarkdown>
      </Wrap>
    </Wrap>
  );
}

/** Whether a description contains at least one renderable image ref. */
export function hasImageRef(text: string): boolean {
  return new RegExp(IMG_PATTERN).test(text);
}
