<div align="center">

<h1>🛸 Bead Me Up, Scotty</h1>

<p>
  <b>The free, open-source visual UI for <a href="https://github.com/gastownhall/beads">Beads</a></b> — Steve Yegge's
  graph-based issue tracker for AI coding agents.<br/>
  <i>Brainstorm, create, and organize work in the same place your AI agent does.</i>
</p>

<table>
  <tr>
    <td>
      <p><strong>✨ A rich, interactive workspace for Beads</strong></p>
      <p><strong>Create beads, edit their details, drag them between columns, and change their status directly in the UI.</strong> Organize subtasks, connect dependencies, and steer the work alongside your AI agents — with changes written back to Beads.</p>
      <p>This is why Scotty was built: to give humans a visual way to <strong>work with beads</strong>, beyond simply viewing them.</p>
    </td>
  </tr>
</table>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-6d5ef0?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js&logoColor=white" alt="Next.js 16">
  <img src="https://img.shields.io/badge/Run_anywhere-scotty-22c55e?style=flat-square" alt="Global CLI: scotty">
  <a href="https://github.com/brendan-appstart/bead-me-up-scotty/stargazers"><img src="https://img.shields.io/github/stars/brendan-appstart/bead-me-up-scotty?style=flat-square&color=eab308" alt="GitHub stars"></a>
</p>

<a href="https://youtu.be/0zpg_FRX-wE" title="Watch the 2-minute demo">
  <img src=".github/screens/board.png" alt="Bead Me Up, Scotty — click to watch the demo" width="860">
</a>

<p><b>▶️ <a href="https://youtu.be/0zpg_FRX-wE">Watch the 2-minute demo</a></b></p>

<p>
  <a href="https://beadmeupscotty.com"><b>🌐 Website</b></a> ·
  <a href="https://youtu.be/0zpg_FRX-wE"><b>▶️ Demo video</b></a> ·
  <a href="https://github.com/brendan-appstart/bead-me-up-scotty"><b>⭐ Star the repo</b></a> ·
  <a href="https://github.com/gastownhall/beads"><b>🧵 Beads</b></a>
</p>

<table>
  <tr>
    <td width="50%" align="center"><img src=".github/screens/detail.png" alt="Detail drawer with inline editing"><br/><sub><b>Detail drawer — inline edit, deps & comments</b></sub></td>
    <td width="50%" align="center"><img src=".github/screens/graph.png" alt="Interactive dependency graph"><br/><sub><b>Live dependency graph</b></sub></td>
  </tr>
</table>

</div>

---

A local, single-user web UI for **[beads](https://github.com/gastownhall/beads)**
(`bd`) — Steve Yegge's distributed graph issue tracker. beads ships a powerful CLI
but no interactive visualizer that also lets you *create* work. This app is that
visualizer: a fast, graph-aware task board for humans, on top of a tracker built
for AI agents.

## Quick install

With [Homebrew](https://brew.sh) (macOS or Linux):

```bash
brew install brendan-appstart/tap/bead-me-up-scotty
scotty
```

Update with `brew upgrade bead-me-up-scotty`. Other options (from source, global
npm, Docker) are below.

## Features

- **Board** — a five-column view (Waiting · Ready · Blocked · In Progress · Done)
  with dense cards showing id, type, priority, assignee, dep/comment counts, and an
  origin badge. Filter by type / priority / origin, full-text search, and a
  show/hide-archived toggle. Keyboard: `n` new, `/` search, `Esc` close.
  A column with no cards (after filters and search) is hidden, and a board with
  no cards shows all five. While you drag a card, a drop bar over the column
  names offers the hidden columns it can be dropped into; the visible columns
  stay where they are, and the bar never covers a card.
- **Waiting ↔ Ready drag-and-drop** — drag cards between columns to change status
  (Waiting = `deferred`, Done = `bd close`); updates are optimistic.
- **Create / edit** — add tasks and epics (type, priority, description, assignee,
  labels, parent epic, start in Waiting) and edit status/priority inline.
- **Epics & progress** — epics with live `closed ÷ children` progress bars and
  expandable child lists; add a child straight into an epic.
- **Dependencies & graph** — view/add/remove typed dependencies in the detail
  drawer, plus an interactive React Flow dependency graph (drag node→node to link).
- **Comments** — author-stamped comment threads with a composer on every bead.
- **Bead links** — open a bead directly with `/p/<project>?bead=<id>`. The address
  bar follows the open drawer; its **Copy link** button copies a shareable link,
  including in read-only mode. Drawer navigation keeps its own Back trail.
- **Archive & delete** — archive (reversible `bd close` + `archived` label) or
  delete (`bd delete`, behind a confirm).
- **Human-vs-agent attribution** — every bead and comment shows 👤 (human) or 🤖
  (agent), derived from a configurable human allowlist.
- **Settings** — repo path, human actor + allowlist, poll interval, and light/dark
  theme. Live polling keeps the board fresh when agents change data underneath you.

### Focus: compare assignees and recent completions

Open **Focus** in the project sidebar. It starts with the existing ungrouped
**In flight**, **Blocked**, and **Next up** columns. In flight includes work
marked `in_progress` or `hooked`; Next up remains ready P0/P1 work.

Choose **Group by → Assignee** in the Focus header to compare each assignee's
work across those columns. Work without an assignee has its own **No assignee**
row. Choose **None** to return to the original layout.

Turn on **Recently finished** to add the latest seven matching completions,
ordered by completion time. The count shows how many are displayed out of the
full matching set; **Show all … completed** expands it, and **Show latest 7**
restores the summary. Existing label-lane filters apply before this limit.
Active and blocked work is never capped, and archived beads stay excluded.

These are temporary display controls for the current Focus visit. They don't
change bead data or the project landing-view preference. Keyboard navigation,
detail links, and read-only protections also work in the grouped layout.

## How it works

- **beads has no HTTP API**, so the app shells out to the `bd` CLI
  (`bd … --json`, `BD_JSON_ENVELOPE=1`). `bd` stays the single source of truth —
  the app adds **zero** new persisted schema. The only adapter is
  [`lib/bd.ts`](lib/bd.ts); see the spec in [`design/design.md`](design/design.md).
- The UI was designed in **Claude Design** and rebuilt faithfully here with
  Next.js + shadcn/Tailwind. The original export and a screen/token map live in
  [`design/ui-export/`](design/ui-export/).

### Columns & attribution (design decisions)
- Work that has not started sits on the left. **Waiting** holds beads with
  beads' built-in `deferred` status, and open beads that wait on other open
  work (an agent's later plan steps). **Ready** = open & unblocked.
  **Blocked** holds status `blocked`, and open beads that wait on a person: a
  blocking dependency that **Needs You** lists and that you can act on now (a
  `human` item or a human gate that is not deferred and not itself blocked). A
  person item that is deferred or still blocked counts as other work, so its
  dependents wait in Waiting. **In Progress** keeps started work, even when it
  gains a blocker. A bead labelled `question`, `assumption` or `blocker` is an
  **item** for a person, not work: it sits in no column (open or closed), and
  Focus and Insights leave it out. It still decides where the work that
  depends on it goes, and it stays in Needs You, the drawer, search and the
  List view (in its own "Items for you" group, with an item chip). The `human`
  label alone does not make an item. Dragging between columns runs `bd update --status` /
  `bd close`; the card then sits where these rules put it (a toast says so when
  that is another column). To park an open card that waits on work, use the
  status control in its drawer: it already sits in Waiting, so a drag there is
  a reorder.
- beads has no human-vs-agent flag, so the UI stamps its own writes with a
  configured **human actor** (`BEADS_ACTOR`); anyone in the human allowlist renders
  as 👤, everyone else as 🤖. **Archive** = `bd close` + an `archived` label
  (reversible); **Delete** = `bd delete`.

## Releases and updates

[Latest stable release](https://github.com/brendan-appstart/bead-me-up-scotty/releases/latest)
contains version-specific installation instructions, changes, and screenshots.
The sidebar displays the running app version.

In **Settings → Software updates**, choose **Stable releases** (the default) or
**Development (main)**. Stable checks published GitHub releases for all installation
types. Development checks the latest main commit and requires a Git checkout.
Checks run on load and every five minutes; disabling them takes effect immediately.
These GitHub requests are independent of the optional usage-statistics setting.

When a new version is available, click the sidebar notice to read its release notes.
A clean main/detached Git checkout can install the exact advertised target with
**Update now**. Dependencies are restored with `npm ci` and the app is rebuilt.
The supervised `npm run serve` launcher restarts automatically; other launchers
need a manual restart. Local changes or diverged history must be resolved first.
Global copies, source downloads, and Docker installations receive the notice with
manual update instructions. No update is installed automatically.

See [v0.2.0 release notes](docs/releases/v0.2.0.md) for the first versioned release.

## Run it

**Prerequisites:** Node 20+ and npm. For live mode you also need the
[`bd`](https://github.com/gastownhall/beads) binary on your `PATH` and a `.beads`
repo (`bd init`). No `bd`? The app falls back to demo mode automatically.

```bash
npm install
npm run dev            # http://localhost:3000
```

- **With real data:** run from (or point Settings at) a directory containing a
  `.beads` repo, with `bd` on your `PATH`. Override the repo with
  `BEADS_REPO=/path/to/project` and the binary with `BD_BIN=/path/to/bd`.
- **Demo mode:** if `bd` isn't installed (or you set `BEADS_DEMO=1`), the app runs
  against an in-memory dataset seeded from the design export — so you can explore
  every feature without beads. The sidebar shows which mode is active.

Set the human actor / allowlist, repo path, and theme in **Settings** (stored
under your OS config dir, not in beads).

### Focus view

**Focus** is an optional view for current work: In flight, Blocked, and Next up
(open, unblocked P0/P1 work). Board is the default whenever you open or reload a
project. Enable **Use Focus as the default view** in Settings to start in Focus instead. This toggle is off
by default and saves automatically for all projects in the current browser.
Lower-priority backlog and completed work remain
available in Board and List.

Set `SCOTTY_LANE_PREFIX=ctx:` to enable lane filters from labels such as
`ctx:frontend`. Without a prefix, lane filters are hidden. If a selected lane
vanishes during a live refresh, Focus shows all lanes again.

### Read-only viewing

Enable **Read-only mode** in Settings to monitor progress without editing beads.
The slim **Read Only Mode** banner stays above the project workspace. Click it
to keep or disable the mode, choose a small or large banner, or pick its background
and text colors. Appearance changes are saved automatically in this browser.

The mode applies to the current browser session, including its other tabs. A
session cookie preserves it through reloads; browser session restoration may
also restore that cookie. Other browser sessions are unaffected. Settings lets
you enable it again after dismissing the banner.

Set `SCOTTY_READ_ONLY=1` (or `true`) when launching Scotty to make read-only the
default for new browser sessions. A browser can explicitly override that default
from the banner. This is a local viewing preference, not a permissions system.
Project write requests are rejected by the server while the requesting browser
is read-only; application settings remain available.

### Respond and Dismiss in Needs You

Respond and Dismiss close the item like `bd human respond` / `bd human dismiss`
(close reasons `Responded` / `Dismissed`). The `human` label stays, so the
record and `bd human stats` stay intact, and a work bead that depended on the
question becomes ready. Set `SCOTTY_HUMAN_RESPOND=keep-open` to get the old
behaviour (Respond comments and clears the label; the bead stays open).

### Storing the manual order in beads

By default the Manual sort order stays in Scotty's own `config.json`, so only
Scotty sees it. Turn on **Manual order** in Settings (or launch with
`SCOTTY_ORDER_STORE=beads` to make it the default) and Scotty writes each
card's position to its `scotty.rank` metadata instead (position × 1024, only on
beads whose rank changes). Agents and other clients then see the order in
`bd list --json` and `bd ready --json`. Your saved order is copied across once
when you switch it on. `scripts/test-order-store.mjs` documents how to test it.

### Links to repo items in board text

In a description, a comment, notes and the text of a version-2 question,
references to repo items become links:

- an item id of this board (`bd-36g`): the item, in its drawer;
- a commit SHA (7 to 40 lower-case hex characters, at least one digit and one
  letter, a whole word), `#N` and `owner/repo#N`: GitHub, in a new tab;
- a repo-relative file path, with an optional `:LINE`, `~LINE` or
  `:LINE:COL` (`lib/repo-refs.ts:68`): the file link, in a new tab.

Text in a fenced or indented code block, and the text of a link someone wrote,
stays as it is. Inline code is linked when its whole content is one reference.
An option label or description in a question shows a reference as plain text:
a link cannot nest in the option's button.

Commits, issues and paths need a provider: `SCOTTY_REPO_REFS_URL` names a URL
on the same origin (`{project}` becomes the project id). `GET <url>` answers
`{"github": "owner/repo" | null, "file_link": "<template>" | null, "files": []}`,
and `GET <url>?path=a&path=b` lists in `files` the asked paths that are files
of the project's checkout. The template takes `{path}`, `{line}` and `{column}`
and must give a path on this origin or an `https://` URL. Without a provider,
or without a GitHub repo, those references stay text: a path becomes a link
only when the provider says that the file exists. `scripts/test-repo-refs.mjs`
(the rules) and `scripts/test-repo-refs-ui.mjs` (Playwright, 390x844) test it.

### Opening Scotty by a hostname

Scotty only answers browsers that address it as `localhost` (or `*.localhost`)
or by an IP address such as `127.0.0.1` or `192.168.1.20`. Requests that arrive
under any other hostname, and writes sent from another website, are refused.
This stops web pages you visit from changing your beads or reading them through
DNS rebinding. If you reach Scotty through a LAN name (`mybox.local`) or a
reverse proxy domain, allow it explicitly:

```bash
SCOTTY_ALLOWED_HOSTS=mybox.local,tracker.example.com scotty
```

`SCOTTY_ALLOWED_HOSTS=*` accepts any hostname. That turns off the DNS-rebinding
protection, so only use it when something else (a reverse proxy, a private
network) decides who can reach Scotty. Writes sent from other websites are
still refused even with `*`; to accept writes from a proxy's address, list
that name explicitly. Each refusal explains which setting would allow it, both
in the browser and once in the terminal running Scotty.

Scripts and tools that call the API at `localhost` or an IP address are
unaffected; only browser requests carry the `Origin` header that the
cross-site check looks at.

### Serving Scotty under a sub-path

To put Scotty at `https://example.com/board/` instead of the root of a host,
set `SCOTTY_BASE_PATH` to the sub-path (leading slash, no trailing slash). It
becomes Next's `basePath`, and the pages, assets, API, live-update stream,
notification links and copied permalinks all move under it. Unset (the default)
changes nothing.

The prefix is fixed **at build time**: the client bundle has it inlined. Set it
for the build, and again when you start the server:

```bash
SCOTTY_BASE_PATH=/board npm run build
SCOTTY_BASE_PATH=/board npm run start
# Scotty is now at http://localhost:3000/board ; /api/... is no longer served at the root
```

Your proxy forwards the prefix unchanged (do not strip it) and should not
buffer the server-sent-events stream. Remember `SCOTTY_ALLOWED_HOSTS` for the
public hostname (see above).

```nginx
location /board/ {
  proxy_pass http://127.0.0.1:3000;      # no trailing slash: keep /board in the path
  proxy_set_header Host $host;
  proxy_http_version 1.1;
  proxy_buffering off;                   # /api/p/<id>/beads/stream is SSE
}
```

```caddy
example.com {
  reverse_proxy /board/* 127.0.0.1:3000
}
```

```bash
# Tailscale Serve: --set-path keeps the prefix on the upstream URL
tailscale serve --bg --set-path /board http://127.0.0.1:3000/board
```

Code that reuses `lib/api-client.ts` outside Scotty's own UI can point it at a
different API prefix without editing the file: call `setApiRoot("/api/tracker")`
at startup, or build with `NEXT_PUBLIC_SCOTTY_API_ROOT`. It defaults to the base
path above.

### Docker

```bash
docker build -t bead-me-up-scotty .
docker run -p 3000:3000 bead-me-up-scotty      # → http://localhost:3000
```

> The build runs `npm ci`, which needs the committed `package-lock.json` for
> reproducible installs. The lockfile is tracked in the repo (a `.gitignore`
> negation keeps it that way even if your global gitignore excludes lockfiles),
> so a clean clone builds without a prior `npm install`.

The image includes the `bd` CLI, so real data works out of the box — just
mount your project directory and point `BEADS_REPO` at it:

```bash
BEADS_REPO=/path/to/project
docker run -d -p 3000:3000 \
  --name beads_ui \
  -v $BEADS_REPO:/data \
  -e BEADS_REPO=/data \
  bead-me-up-scotty
```

The container runs as a non-root `nextjs` user with `HOME=/home/nextjs` and
`XDG_CONFIG_HOME=/home/nextjs/.config`, so `bd` and app settings have a valid
runtime config directory. On Linux, if `bd` fails with permission errors writing
to the mounted `.beads` directory, run as your host user: `--user $(id -u):$(id -g)`
(the config dirs are world-writable, so settings keep working). Settings live
inside the container, so they are lost when it is recreated — bind-mount the
config dir to keep them:

```bash
-v "$HOME/.config/bead-me-up-scotty:/home/nextjs/.config/bead-me-up-scotty"
```

Container limitations:

- The image has no `git`, so Dolt remote sync (`refs/dolt/data`) and `bd init`
  don't work inside it — run those on the host. UI edits (create/update/close)
  work fine; they just won't auto-push until you sync from the host.
- **Refine with AI** shells out to the Claude Code CLI, which isn't bundled;
  the button shows an error in the container.
- The bundled `bd` version is pinned in the Dockerfile (`ARG BD_VERSION`);
  override with `--build-arg BD_VERSION=<version>` to match your host.
- Opening the container as `http://localhost:3000` or by IP works as-is; to use
  a hostname, pass `-e SCOTTY_ALLOWED_HOSTS=<name>` (see
  [Opening Scotty by a hostname](#opening-scotty-by-a-hostname)).

## Install globally

Install once from a clone, then run `scotty` (or `bead-me-up-scotty`) from **any**
directory. It starts the production server on a free port (default 3000) and opens
your browser. Run it from a folder that has a `.beads` repo to jump straight to
that project; otherwise you get the project picker. Requires Node 20+.

Flags: `-p, --port <n>` · `--no-open` · `--help`.

**Recommended — `npm link` (keep the clone):**

```bash
git clone <repo-url> bead-me-up-scotty
cd bead-me-up-scotty
npm install
npm run build
npm link
scotty                 # from anywhere
```

The global command is a symlink to the clone, so keep it on disk and re-run
`npm run build` after pulling changes. Uninstall: `npm rm -g bead-me-up-scotty`.

**Alternative — global copy (clone is deletable):**

```bash
git clone <repo-url> bead-me-up-scotty
cd bead-me-up-scotty
npm install
rm -rf .next           # ensure a clean build (only the prod build is shipped)
npm run build
npm install -g .
scotty                 # from anywhere; the clone can now be deleted
```

To update, rebuild and re-run `npm install -g .`. If `npm install -g .` hits a
permissions error, use a user-owned npm prefix:
`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to your `PATH`.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · shadcn/ui ·
TanStack Query (polling + optimistic DnD) · dnd-kit (board) · @xyflow/react
(dependency graph) · Zod (validates `bd` output *and* forms).

## Project layout

```
app/                  # pages + API route handlers (the only server entry points)
  api/beads/**        # GET list, POST create, [id] PATCH/DELETE, status, comments, deps, archive
  api/doctor, config  # bd preflight + local config
lib/
  bd.ts               # the ONLY bd CLI bridge (execFile, JSON envelope, write mutex)
  demo-store.ts       # in-memory fallback seeded from the export
  store.ts            # picks bd vs demo
  schema.ts           # Zod schemas + types (bd data model)
  beads-view.ts       # pure view-model helpers (status/priority colors, blocked, epic progress)
  attribution.ts      # human-vs-agent origin
components/           # sidebar, board (dnd), detail drawer, create modal, epics, graph, settings
```

## Verify

```bash
npm run build         # typecheck + production build
npm run lint          # eslint
node scripts/test-bd-args.mjs  # a comment or a title that starts with "-" stays text
```

`lib/bd.ts` passes a comment after `--` and a title as `--title=<text>`. bd reads
a flag anywhere in its argv, so a comment such as `--file=PATH` would otherwise
make bd read that file into the comment.

## License

[MIT](LICENSE) © Brendan

### Basic usage statistics

Scotty ships with a public, ingestion-only PostHog project token and reports one
`app_active` event per UTC day while the UI is used. **Fresh installations are
enabled and configured by default; no `.env` setup is needed.** Cloning or
installing alone does not send an event; opening the app does.

Operators can set `POSTHOG_KEY` to their own PostHog **project token**, never a
personal API key, and `POSTHOG_HOST` to their ingestion endpoint (default:
`https://us.i.posthog.com`). An explicitly empty `POSTHOG_KEY=` disables reporting
even when the preference is on. These are runtime environment settings; Next.js
also loads them from a local `.env`. Do not commit `.env` or private API keys.

**Settings → Usage statistics → Share basic usage statistics** is enabled by
default. Switching it off stops future events across all projects and browsers
connected to that local server. It does not delete previously received events.
The preference lives in
`$XDG_CONFIG_HOME/bead-me-up-scotty/telemetry.json` (default:
`~/.config/bead-me-up-scotty/telemetry.json`), outside the Beads database.
The random installation ID is stored alongside it in `telemetry.json.id`;
daily event records, attempt reservations, and acknowledgements live in
`telemetry.json.days/`. They coordinate server processes without a lock that
could remain stuck after a crash. Existing opt-outs and daily reservations
remain honored after an update.

Scotty sends only the random installation/event IDs, app version, timestamp,
and PostHog flags that disable person profiles and GeoIP enrichment. No browser analytics SDK is
loaded; no automatic page/click capture or session recording is enabled. Bead
content, project names/paths, user names, emails, URLs, and browser headers are
never included. PostHog receives the network connection and records the app
server's IP address, even though GeoIP enrichment is disabled.
An idle server/background tab sends nothing. Failures time out after three
seconds and never affect app operations. Failed deliveries can retry during
later UI use, at least ten minutes apart and at most three attempts per UTC day.
Retries retain the same event ID and timestamp for PostHog's eventual
deduplication; no past days are backfilled. Opting out stops pending retries.
If the preference cannot be read or the daily reservation cannot be saved,
reporting stops.

In PostHog, create a Product Analytics trend for `app_active`, choose **Unique
users**, and use daily, weekly, or monthly intervals. This measures approximate
active **installations**, not people: multiple machines count separately, shared
servers count once, and offline or opted-out installations are absent. Deleting the preference file restores the default setting; deleting the ID file
resets the installation identity.

Verify the capture and privacy rules with `node scripts/test-telemetry.mjs`
(Node 22.18+ for native TypeScript support). The tests use temporary local storage
and a fake network transport; they do not send production events.

For the Settings browser checks, start an isolated server with
`XDG_CONFIG_HOME=/tmp/scotty-usage-test POSTHOG_KEY='' BEADS_DEMO=1 SCOTTY_READ_ONLY=1 npm run start -- --port 3197`,
then run `SCOTTY_TEST_URL=http://localhost:3197 node scripts/test-telemetry-ui.mjs`.
The test refuses to run against an installation configured to send events.

## A small usage signal, and a thank you

When PostHog reporting is configured, Scotty sends a small signal that the app
was used, at most once a day. It helps us get a rough sense of how many
installations are active and whether people keep coming back.

The event includes a randomly generated installation ID, the app version, and
a timestamp. The ID lets us recognize the same installation on another day;
it isn't your name, email, or account. We don't send your beads, project names,
file paths, or anything you type, and we don't record your sessions or clicks.
Person profiles and location enrichment are disabled. PostHog still receives
the network connection, so we don't promise “100% anonymity.”

**You can turn it off at any time in Settings → Usage statistics → Share basic
usage statistics.** That stops future events, and your choice stays saved across
restarts. The app works just as well with reporting disabled.

Feel free to disable it. But knowing that people are using the app helps my
team and me decide where to focus our time, and encourages us to keep adding
updates and making it better. I truly appreciate everyone who shares feedback,
including through this small usage signal. Seeing that something we've built
is useful to you is inspiring. Thank you for being part of it.


### To Review

When a manager answers an agent's question for you, the question closes at once and the agent can go on. The answer then shows in **To Review**, next to Needs You. It is not a board column, and it adds nothing to Needs You. The sidebar item shows a count when something is waiting.

Each row shows the question, the manager's answer, its reason (`board.review_reason`) and who asked. **Accept** keeps the answer and the row leaves. **Reverse** opens the same answer controls as Needs You: pick another option or write an answer. The agent then gets your answer as a new answer from you. **Comment** writes a comment on the answer for your manager, with no verdict: the row stays, and `board.review` stays `pending` until you accept or reverse it. The row then shows your comments. **Accept all** asks once ("Accept all N answers?") and then accepts the open project's pending rows one by one. It waits while a Reverse or a Comment box is in use, and while a comment is unsent. Cancel keeps an unsent comment on the row, and the row's Accept and Reverse wait for it: Send it, or Discard it. Nothing leaves by itself.

The record keeps who answered and who reviewed, and when: `board.review` (`pending`, `accepted` or `reversed`), `board.reviewed_by` and `board.reviewed_at`. The route is `POST /api/p/{project}/beads/{id}/review` with `{"action":"accept"}` or `{"action":"reverse","answer":{...}}`, where `answer` is a human-route body. A comment uses the ordinary comments route, `POST /api/p/{project}/beads/{id}/comments` with `{"text"}`; it changes no review key.

### Choices in Needs You

Agents can store choices in vanilla bd metadata under `scotty.choices`.
The inbox and item detail show one button per option, with the recommended option first.
Free-text replies remain available. Dismiss selects the recommended option.
Decline question requires a reason and closes the item as Declined.
Its comment explicitly records that the person declines the question; it selects no option.
Set `multiSelect` to true to select several options before pressing Respond.
Text in the answer box goes with the answer: with a tapped option, with the selected options, and with Dismiss.
The comment keeps it as a `The person also wrote: <note>` paragraph and as the fence's last key, `note`.
Text alone, with no option selected, is a free-text answer. Decline uses the text as its reason.
On an item without choices, Dismiss keeps the text as a plain comment.

```json
{
  "scotty.choices": {
    "version": 1,
    "multiSelect": false,
    "options": [
      {"id":"blue","label":"Use blue","description":"Keep the existing theme.","recommended":true},
      {"id":"green","label":"Use green","description":"Create a new theme.","recommended":false}
    ]
  }
}
```

Save this JSON in a file. Apply it with `bd update ITEM --metadata @choices.json`.
Use two to four unique option IDs, with exactly one recommendation.
Labels have at most 80 characters; descriptions have at most 240 characters.
The definition has an 8 KiB limit. Invalid definitions retain the ordinary reply controls.
The human route validates submitted snapshots against the current options before writing a comment.
Comments preserve the selected labels and descriptions in canonical fenced JSON.
Older builds ignore the metadata and retain free-text replies and Dismiss.

Run `node scripts/test-human-choices.mjs` for the pure contract tests (Node 22.18+).
The API and UI scripts require `SCOTTY_TEST_URL`, `SCOTTY_CHOICES_REPO`, and an isolated disposable board.
Use `SCOTTY_TEST_BD` to select bd and `SCOTTY_BROWSER_EXECUTABLE` to select a headless browser.
Run `node scripts/test-human-choices-api.mjs`, `node scripts/test-human-decline-api.mjs`, `node scripts/test-human-choices-ui.mjs`, and `node scripts/test-human-note-ui.mjs` on those fixtures.
Run `node scripts/test-human-note.mjs` for the pure checks of a note in the human route.
An answer takes one slot of the board's bd queue: its steps (read, comment, close, read) run back to back, and a list request made meanwhile runs after the close.
A To Review Accept or Reverse takes one slot the same way.
An answer is written once per click: the page sends a random click id (`click_id`) with each try of a click, and the route marks the item with it (`scotty.answer_click`, after the comment and before the close; with the review record for Accept and Reverse). On an open item, a retry of the same click finds its mark and does not write the comment again; an edited answer is a new click. A closed or done item takes no answer (`stale_question`), also with this click's mark: the mark comes before the close, so it does not say who closed the item. No clock is compared. When the mark write fails for an answer with a comment, the item is not closed and the route answers `answer_saved_close_failed`; a retry then writes the comment again (the known limit); a bare Dismiss answers bd's own error. Any answer (a plain Respond, a choice, a group, a bare Dismiss) on an item that is not waiting (closed, deferred, without the `human` label, or done) is refused with `stale_question` before its shape is checked.
A close that fails after the answer is saved answers 500 `answer_saved_close_failed` ("Your answer is saved; closing failed: try again.").
Each bd call stops after 60 seconds (`SCOTTY_BD_TIMEOUT_MS` overrides it) with the code `bd_timeout`, so one hung call holds a board's queue for at most 60 s. The limit stops the process that `BD_BIN` names only: a wrapper's own child (as in `scripts/slow-bd.sh`) keeps running.
Run `node scripts/test-human-answer-slot.mjs` for those checks (a fake bd, and a sleeping fake bd in a temporary folder; no server or board).
An answered item leaves Needs You (or To Review) at the click and shows "Sending…"; a short confirmation follows the write.
An older list that arrives meanwhile never brings it back; a failed write brings it back in its place with its error and what was typed.
The page waits 30 seconds for an answer; then the item comes back, saying the answer may still be saved. After a failure that may have been written (no response, or a 5xx), the page reads the item again and decides one of three cases, never "sent": open with this click's mark: "Your answer is saved; closing failed: try again." (a retry only closes); open without it: the failure as it is; closed or done now, by anyone: "This question is closed now. Your answer may or may not be the one recorded: open the item to check." with the typed text, and OK removes the card. When the board settles an item after an uncertain failure, the card takes those neutral words (only while that try is the item's latest).
An error shows only in the form of its own kind, and an edit or another action clears it. The outbox keeps its entries per project.
Run `node scripts/test-answer-outbox.mjs` for the pure rules.
Run `node scripts/test-answer-speed-ui.mjs` against an isolated server started with `BD_BIN=scripts/slow-bd.sh`, `SCOTTY_SLOW_BD_REAL` (the real bd) and `SCOTTY_SLOW_BD_DIR` (a control folder that the test also gets): the test slows bd or fails one write through files in that folder.

Version 2 groups one to four questions in the same item:

```json
{
  "scotty.choices": {
    "version": 2,
    "questions": [{
      "id": "theme",
      "question": "Which theme should the page use?",
      "header": "Theme",
      "multiSelect": false,
      "options": [
        {"id":"blue","label":"Use blue","description":"Keep blue.","recommended":true},
        {"id":"green","label":"Use green","description":"Create green.","recommended":false}
      ]
    }]
  }
}
```

Each question has its own presets, free-text field, and Decline question action.
A question's text goes with its selected options as its note, and with Dismiss.
The operator answers or declines every question, then presses Respond once.
Dismiss selects every recommendation. One comment preserves all results in a `board-answers` JSON fence.
Question IDs are unique. Headers contain 1-12 characters; question text has at most 500 characters.
The version 2 definition limit is 32 KiB. Version 1 retains its existing controls.
Run `node scripts/test-questionnaire.mjs` for the group contract tests.
Run `node scripts/test-questionnaire-api-ui.mjs` against the isolated server and disposable board for group API and browser checks.
