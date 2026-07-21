# @loopkit/console

A thin, generic HTTP console for a loopkit ledger: four read views plus four operator verbs.

loopkit is an event-sourced autonomous delivery plane: an append-only work ledger folds into
projections, and beats build work items in git worktrees, gate them, merge them, and tier
acceptance. An operator needs one small window onto that ledger, and a way to drive it without a
terminal. This package is that window — deliberately thin, with zero product assumptions and
zero runtime dependencies beyond Node's built-ins.

## What it does

Reads the ledger via `@loopkit/core`'s public fold API (`loadAllEvents` + `fold`) on every
request and serves four server-rendered views:

- **`/`** — Work board: items grouped by state (queued · building · gated · needs-you/parked ·
  merged/awaiting-acceptance · accepted/terminal), with per-group counts, and the intent-capture
  form.
- **`/item/<id>`** — Item timeline: the item's events in order (timestamp, actor, type, a
  one-line summary of the event's data), with approve/reject or accept forms when applicable.
- **`/needs-you`** — Parked items awaiting an operator decision (approve/reject forms), plus
  merged items awaiting acceptance (accept forms).
- **`/health`** — Last-event age, ledger segment sizes, and event counts by type.

It also exposes four write verbs, equivalent to the `loopctl` CLI commands of the same name and
implemented by the SAME `@loopkit/core` functions (`captureIntent` / `approveOrReject` /
`acceptItem`) — no verb logic is duplicated here:

- **`POST /intent`** — capture a new work item from the board's text box (`loopctl new`). Stamps
  the sole registered target automatically; with 2+ targets, the form requires a selection.
- **`POST /item/<id>/approve`** and **`POST /item/<id>/reject`** — decide a parked item.
- **`POST /item/<id>/accept`** — accept a merged item awaiting acceptance.

Every ledger-derived string is HTML-escaped before it reaches the page. Every view and every
write **works with JavaScript off**: each write is a plain HTML `<form>` POST, answered with a
303 redirect back to the referring view (POST-redirect-GET) — a page refresh never re-submits.
On top of that no-JS baseline, the server also serves a small, fixed set of external scripts
(shell, command palette, composer, confirmation dialogs, and an SSE live-update feed — see
`SHELL_SCRIPTS` in `src/html.ts`) that progressively enhance the same pages; none of them are
required for a view to render or a verb to work. The server holds no mutable in-process state;
every GET still re-derives its output fresh from the ledger. Writes append to the ledger through
`@loopkit/core`'s `withLock` — the same single-writer lock path the CLI and the beats use.

Because the console now accepts writes, it binds `127.0.0.1` by default and enforces an
Origin/Referer-vs-Host check on every POST (any page open in the operator's browser can still
target `http://127.0.0.1:<port>`, so loopback binding alone is not enough) plus a 64KB request
body cap.

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
