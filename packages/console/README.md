# @loopkit/console

A thin, generic HTTP console for a loopkit ledger: server-rendered projections, item evidence,
conversation history, and explicit operator actions.

loopkit is an event-sourced autonomous delivery plane: an append-only work ledger folds into
projections, and beats build work items in git worktrees, gate them, merge them, and tier
acceptance. An operator needs one small window onto that ledger, and a way to drive it without a
terminal. This package is that window — deliberately thin, with zero product assumptions and
no third-party runtime dependencies beyond Node's built-ins and the loopkit workspace packages.

## What it does

Reads the ledger via `@loopkit/core`'s public fold API (`loadAllEvents` + `fold`) and serves these
canonical, server-rendered routes:

- **`/command`** — operating picture, decision desk, active flow, recent captures and outcomes.
- **`/work`** — active work, queue, parked work, backlog, worker sessions and engine diagnostics.
- **`/acceptance`** — merged slices grouped by acceptance tier, with criteria, certification and
  the evidence currently recorded in the ledger.
- **`/health`** — SLO rollup, autonomy state, self-heal activity and recent build artifacts.
- **`/company`** — Decisions & docs. Recent active decisions are the default; query, status,
  target and page filters are bookmarkable, and superseded decisions appear only when requested.
- **`/observability`** — plane spend, quota, provider, judge, routing, repair and token telemetry.
- **`/threads`** and **`/threads/<external-ref>`** — paginated conversations and thread detail.
- **`/item/<WI-NNN>`** — the canonical item hub: state, available actions, timeline,
  conversation and evidence. Other supported item-id shapes retain the legacy timeline view.
- **`/activity`** — the canonical paginated global ledger history, newest first.

Compatibility redirects preserve older bookmarks: `/` and `/needs-you` go to `/command`;
`/missions`, `/system`, `/knowledge` and `/analytics` redirect to their canonical routes.
`/timeline` is compatibility-only: the global route redirects to `/activity`, while
`/timeline?item=WI-NNN` redirects to the canonical `/item/WI-NNN` hub.
Artifact and attachment download routes serve only validated, bounded paths.

Operator writes use the SAME `@loopkit/core` verb functions as `loopctl`; the console does not
reimplement their transition rules:

- **`POST /intent`** captures a work item (`loopctl new`). It stamps the sole target
  automatically; with multiple targets, the form requires a selection. Attachments are
  supported within the documented request limits.
- **`POST /item/<id>/approve`**, **`POST /item/<id>/reject`** and
  **`POST /item/<id>/accept`** decide parked work or accept a merged item.
- **`POST /item/<id>/reply`** appends a conversation reply.
- **`POST /item/<id>/feedback`** records a problem report on merged work and opens the linked
  follow-up work item through core.
- **`POST /item/<id>/stop`**, **`POST /item/<id>/hold`**,
  **`POST /item/<id>/resume`**, **`POST /item/<id>/requeue`**,
  **`POST /item/<id>/escalate`** and **`POST /item/<id>/dismiss`** expose the state-bounded
  run controls.
- **`POST /theme`** stores only the console colour preference; it does not mutate the ledger.

Some zero-JS buttons submit exact command strings through `/intent`. Those strings are matched
deterministically and dispatched to the same core verbs; they do not enter the capture or model
routing path.

Every ledger-derived string is HTML-escaped before it reaches the page. Every view and every
write **works with JavaScript off**: each write is a plain HTML `<form>` POST, answered with a
303 redirect back to the referring view (POST-redirect-GET) — a page refresh never re-submits.
On top of that no-JS baseline, the server serves a fixed set of external shell, palette,
composer, confirmation and SSE scripts under `/ui/*.js` (plus the remaining legacy
`/console-*.js` assets). They progressively enhance the same links and forms; none is required
for a page to render or an action to work. The ledger remains the only authoritative work
state. Writes append through `@loopkit/core`'s `withLock`, the same single-writer path used by
the CLI and beats.

Because the console now accepts writes, it binds `127.0.0.1` by default and enforces an
Origin/Referer-vs-Host check on every POST (any page open in the operator's browser can still
target `http://127.0.0.1:<port>`, so loopback binding alone is not enough) plus a 64KB request
body cap for URL-encoded forms. Multipart intent/reply/feedback forms are capped at 8MB and five
attachments. Redirect targets are restricted to same-server paths. Startup also refuses a
checkout known to be behind or diverged from its configured upstream, preventing the console
from silently serving stale source assets.

## Usage

```ts
import { startConsole } from '@loopkit/console';

const handle = await startConsole({
  ledgerDir: '.ai/ledger',
  repoRoot: process.cwd(), // used by the approve verb's branch-existence check
  port: 4100,
});
console.log(`console listening on :${handle.port}`);

// later
await handle.close();
```

## Screenshot

See [`docs/console.png`](../../docs/console.png) — the console's Command view rendered against a
seeded ledger of dummy work items (see `docs/demo-recording.md` for how it was captured).

## Develop

```sh
npm install   # from the workspace root
npm run build --workspace=@loopkit/console
npm test --workspace=@loopkit/console
```
