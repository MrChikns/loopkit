/**
 * server.ts — the console HTTP server: four read-only views plus the operator write verbs
 * (capture / approve / reject / accept / reply / feedback / the run-control set — stop / hold /
 * resume / requeue / escalate / dismiss). Every write is a plain HTML form POST, answered with a
 * 303 redirect back to the referring view (POST-redirect-GET) — the client-JS layer
 * (public/console-*.js) only progressively enhances that same POST/GET surface, it never opens a
 * new write path of its own.
 *
 * Reads stay read-only by construction: every GET re-loads the ledger and folds it fresh
 * (loadAllEvents + fold), never holds mutable in-process state. Writes append to the ledger
 * through @loopkit/core's shared verb functions (captureIntent/approveOrReject/acceptItem/
 * replyToItem/captureFeedback/stopBuild/holdItem/unparkItem/escalateItem/dismissItem) — the SAME
 * functions `loopctl` uses, going through the same withLock single-writer path. No verb logic is
 * reimplemented here.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFile, readdir, stat, access, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, extname, basename, resolve as resolvePath, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  loadAllEvents,
  fold,
  makeEvent,
  withLock,
  captureIntent,
  approveOrReject,
  acceptItem,
  replyToItem,
  captureFeedback,
  stopBuild,
  holdItem,
  unparkItem,
  escalateItem,
  dismissItem,
  isHeldPark,
  isOpsPark,
  loadConfig,
  loadQuarantine,
  resolvePlaneHome,
  TARGET_ID_RE,
  VerbError,
} from '@loopkit/core';
import type { FoldResult, ItemRecord, KnowledgeConfig, KnowledgeEntry, CaptureIntentOptions, MsgOutData } from '@loopkit/core';

import { generateTokensCss } from '@loopkit/ui';
import { createRequire } from 'node:module';

// WI-053/WI-055: after the opsPages rewiring + the legacy-shell convergence, only
// renderItemTimeline (legacy non-WI item ids, e.g. CONV-N) still backs a live route from this
// module. /activity and the write-verb error/404 envelopes converged onto opsPages.ts's
// opsui-shelled renderActivityPage/renderErrorPage/renderNotFoundPage (WI-055 item 1); the
// remaining old renderers (renderMissions/Acceptance/System/Analytics/Knowledge,
// tierConfigFromLoopkitConfig) are no longer called here; they stay exported from views.ts as
// the console package's public API (index.ts re-exports them) — pruning that surface is a
// separate API decision, not this cleanup. (renderCommand itself — the pre-opsPages Command
// renderer — was dead code with no live caller and was deleted; renderCommandPage is the only
// Command-page renderer now.)
import {
  renderItemTimeline,
  SegmentInfo,
  ArtifactEntry,
  ARTIFACT_FILENAME_RE,
  ARTIFACT_KIND_LABELS,
} from './views.js';
// notFoundPage (the pre-WI-053 html.ts shell) still backs the handful of pre-ledger-read 404s
// (missing static asset/CSS/font/manifest, unknown route method) — those never load OpsData
// today and forcing a ledger read+fold just to 404 a missing .css request would be a real
// behavior/cost change, not a chrome swap. Every operator-facing envelope (the route-miss 404
// once OpsData IS already loaded, and every write-verb failure page) renders through
// opsPages.ts's opsui-shelled equivalents instead (WI-055 item 1).
import { notFoundPage } from './html.js';

// WI-053: the canonical ops-console rendering stack (the @loopkit/opsui projections)
// wired to the standalone core through opsPages.ts — one data seam, no re-implemented markup.
import {
  loadOpsData,
  renderCommandPage,
  renderWorkPage,
  renderAcceptancePage,
  renderHealthPage,
  renderCompanyPage,
  renderObservabilityPage,
  renderThreadsPage,
  renderThreadDetailPage,
  renderItemHubPage,
  renderTimelinePage,
  renderActivityPage,
  renderErrorPage,
  renderNotFoundPage,
} from './opsPages.js';
import type { OpsPageContext, KnowledgeSourceRecord, OpsData } from './opsPages.js';
import { generateTokensCss as opsuiGenerateTokensCss, registeredStylesheets } from '@loopkit/opsui';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the package-level public/ dir relative to this compiled/source file. The real
 * build (dist/server.js) sits one level below the package root; the test build
 * (dist-test/src/server.js) sits two levels below — walk up until `public/` is found so
 * both layouts (and any future outDir) resolve without hardcoding a depth.
 */
async function findPublicDir(): Promise<string> {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'public');
    try {
      await access(candidate);
      return candidate;
    } catch {
      dir = join(dir, '..');
    }
  }
  return join(__dirname, '..', 'public');
}

const publicDirPromise = findPublicDir();

/**
 * Class-9 hardening (docs/hardening-audit.md): several routes below (`serveStaticAsset`,
 * `uiComponentsCss`/`uiFontsCss`/`uiFontWoff2`, `opsuiComponentsCss`/`opsuiProjectionsCss`/
 * `opsuiPublicJs`) readFile CSS/JS straight off this checkout's `src`/`public`/`canonical`
 * trees at request time — there is no compiled/copied dist counterpart for any of them, so
 * they always serve whatever's on disk right now. That's fine for a checkout in sync with
 * its branch, but the prior incident this guards against was a checkout whose HEAD had
 * fallen behind its own upstream (a stale worktree left running): the compiled server logic
 * (`dist/server.js`) was current, yet the live-read assets kept serving the old content
 * indefinitely, silently.
 *
 * This only fires when the checkout's current branch has an upstream configured — a
 * detached/feature-branch build worktree (this repo's normal `fast-drain` builder shape) has
 * no upstream and nothing to drift against, so it's left alone. It also never does a network
 * `git fetch`: it compares HEAD against the already-known remote-tracking ref, so it can't
 * hang or fail on a missing network and only ever reports drift the checkout could already
 * have known about locally.
 *
 * "Ahead of origin" (unpushed local commits, upstream is an ancestor of HEAD) is a healthy,
 * expected pre-push state — the on-disk CSS/JS is *newer* than origin, never stale — so it is
 * explicitly allowed via `git merge-base --is-ancestor @{u} HEAD`. Only genuinely BEHIND (HEAD
 * is an ancestor of upstream) or DIVERGED (neither is an ancestor of the other) trips the guard.
 */
function checkoutDriftError(dir: string): string | undefined {
  const run = (...args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'pipe' });
  const upstream = run('rev-parse', '@{u}');
  if (upstream.status !== 0) return undefined; // no upstream configured — nothing to check
  const head = run('rev-parse', 'HEAD');
  if (head.status !== 0) return undefined; // not a git checkout — nothing to check
  const headSha = head.stdout.toString('utf8').trim();
  const upstreamSha = upstream.stdout.toString('utf8').trim();
  if (!headSha || !upstreamSha || headSha === upstreamSha) return undefined;
  const upstreamIsAncestor = run('merge-base', '--is-ancestor', '@{u}', 'HEAD');
  if (upstreamIsAncestor.status === 0) return undefined; // ahead of origin — healthy, not stale
  return (
    `console checkout at ${dir} (HEAD ${headSha.slice(0, 12)}) does not match its upstream ` +
    `(${upstreamSha.slice(0, 12)}) — this checkout is behind (or has diverged from) origin, ` +
    `so the CSS/JS this server reads live from src would be stale even though the compiled ` +
    `server code is current. Refusing to start; pull or reset this checkout first.`
  );
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Read a single cookie value by name from a raw Cookie header. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Body size cap for POST requests — an operator form never needs anywhere near this. */
const MAX_BODY_BYTES = 64 * 1024;

async function listSegmentInfo(ledgerDir: string): Promise<SegmentInfo[]> {
  let names: string[];
  try {
    names = await readdir(ledgerDir);
  } catch {
    return [];
  }
  const segments: SegmentInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const st = await stat(join(ledgerDir, name));
      segments.push({ name, bytes: st.size });
    } catch {
      // skip unreadable entries
    }
  }
  segments.sort((a, b) => a.name.localeCompare(b.name));
  return segments;
}

/** Scan one directory (the runs root, or one per-target namespace under it) for files that
 *  match the WI-NNN-attempt-N.* artifact convention. Best-effort: an unreadable dir yields no
 *  entries rather than a 500. */
async function scanArtifactDir(dir: string, targetSeg: string): Promise<ArtifactEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ArtifactEntry[] = [];
  for (const name of names) {
    const m = ARTIFACT_FILENAME_RE.exec(name);
    if (!m) continue;
    try {
      const st = await stat(join(dir, name));
      out.push({
        itemId: m[1] as string,
        attempt: Number(m[2]),
        kind: ARTIFACT_KIND_LABELS[m[3] as string] ?? (m[3] as string),
        filename: name,
        targetSeg,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // unreadable entry — skip
    }
  }
  return out;
}

/**
 * Enumerate every on-disk build artifact under the plane's runs directory: files directly in
 * `runsDir` (untargeted lane, `targetSeg: '_'`) plus one level into each per-target namespace
 * (`runsDir/<targetId>/`, `beats/dispatch.ts`'s `targetRunDir`). Only descends into
 * subdirectories shaped like a target id — lock dirs (`dispatch.lock`) and scratch dirs
 * (`dispatch/`) never match TARGET_ID_RE, so they're skipped without special-casing their names.
 */
async function listArtifacts(runsDir: string): Promise<ArtifactEntry[]> {
  const root = await scanArtifactDir(runsDir, '_');
  let targetSegs: string[];
  try {
    targetSegs = (await readdir(runsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && TARGET_ID_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    targetSegs = [];
  }
  const nested = await Promise.all(targetSegs.map((seg) => scanArtifactDir(join(runsDir, seg), seg)));
  return [root, ...nested].flat();
}

// ---------------------------------------------------------------------------
// Knowledge collection (/company page) — server-side reading of operator-configured
// sources (LoopkitConfig.knowledge). All filesystem I/O for the page lives here; the
// renderer (renderCompanyPage in opsPages.ts) stays a pure string function over the
// collected KnowledgeSourceRecord[].
//
// Two entry shapes (config back-compat): a bare string keeps today's glob
// semantics (each matched .md file → one 'markdown' record); a source object names one
// file and may declare `kind: 'decision-log'` (parsed into decision cards downstream).
// WI-058: a source object's `path` may itself be a glob (e.g. one-decision-per-file ADR
// directories, `docs/decisions/*.md`) — RELATIVE glob paths expand via expandKnowledgePattern
// (same per-source cap, sorted) into one record per matched file, each carrying the entry's
// `kind`; an ABSOLUTE glob path is not expanded (kept literal, simplest safe behavior — an
// absolute glob almost certainly can't stat as a file and falls through to the existing
// unreadable-source error record).
// ---------------------------------------------------------------------------

/** Per-source document cap — a glob like `docs/**` over a big repo must never balloon one
 *  GET into thousands of file reads. */
const KNOWLEDGE_MAX_DOCS_PER_SOURCE = 50;
/** Content cap per document — the page shows a bounded excerpt with the source path, never
 *  a full multi-hundred-KB decision log inline. */
const KNOWLEDGE_EXCERPT_CHARS = 2000;
/** Recursion bound for glob expansion. */
const KNOWLEDGE_WALK_MAX_DEPTH = 8;
/** Directories glob expansion never descends into. */
const KNOWLEDGE_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-test', 'coverage']);

// Compile one knowledge glob to a RegExp over root-relative paths: a `**` followed by a
// slash spans directories (possibly none), a bare `**` matches anything, `*` stays within
// one path segment. (Line comments here: the glob tokens would close a block comment.)
function knowledgeGlobToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  // Two-step: park the multi-segment tokens on placeholder control chars (which can never
  // appear in a config path) so the single-segment `*` translation cannot eat them.
  const translated = escaped
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*');
  return new RegExp(`^${translated}$`);
}

/** Recursively list root-relative `.md` paths under `dir`, bounded by depth and the skip
 *  list. Best-effort: an unreadable directory contributes nothing rather than a 500. */
async function knowledgeWalk(root: string, relDir: string, depth: number, out: string[]): Promise<void> {
  if (depth > KNOWLEDGE_WALK_MAX_DEPTH || out.length >= 5000) return;
  let entries;
  try {
    entries = await readdir(join(root, relDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!KNOWLEDGE_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await knowledgeWalk(root, rel, depth + 1, out);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(rel);
    }
  }
}

/** Expand one configured pattern against a root: a literal path resolves directly (must stay
 *  inside the root — `..` escapes yield nothing); a glob walks the tree for matching `.md`
 *  files. Returns root-relative paths. */
async function expandKnowledgePattern(root: string, pattern: string): Promise<string[]> {
  if (!pattern.includes('*')) {
    const abs = resolvePath(root, pattern);
    if (!abs.startsWith(resolvePath(root) + '/')) return [];
    try {
      const st = await stat(abs);
      return st.isFile() ? [pattern] : [];
    } catch {
      return [];
    }
  }
  const all: string[] = [];
  await knowledgeWalk(root, '', 0, all);
  const re = knowledgeGlobToRegExp(pattern);
  return all.filter((rel) => re.test(rel));
}

/** Read one file into a KnowledgeSourceRecord. A missing/unreadable file yields a record
 *  carrying `error` (never a throw/500); content is bounded at KNOWLEDGE_EXCERPT_CHARS. */
async function readKnowledgeSource(
  targetName: string,
  absPath: string,
  label: string,
  kind: 'markdown' | 'decision-log',
  displayPath: string,
): Promise<KnowledgeSourceRecord> {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) {
      return { targetName, label, path: displayPath, kind, content: '', error: 'source unreadable' };
    }
    const text = await readFile(absPath, 'utf8');
    // Decision logs are parsed downstream over the whole document; markdown cards show a
    // bounded excerpt. Cap markdown here so one GET never inlines a huge file.
    const content = kind === 'decision-log' || text.length <= KNOWLEDGE_EXCERPT_CHARS
      ? text
      : text.slice(0, KNOWLEDGE_EXCERPT_CHARS);
    return { targetName, label, path: displayPath, kind, content, mtime: st.mtimeMs };
  } catch {
    return { targetName, label, path: displayPath, kind, content: '', error: 'source unreadable' };
  }
}

/** Expand one config entry (a glob/path string OR a source object) against a root into
 *  KnowledgeSourceRecords. A string → today's glob semantics (each matched .md is a
 *  markdown record; a pattern that matches nothing contributes no record). A source object
 *  names one file *or* — when its `path` contains `*` and is relative — a glob (WI-058, e.g.
 *  one-decision-per-file ADR directories): expanded the same way as a string entry, but each
 *  resulting record carries the entry's `kind` (and per-file label = basename, same as string
 *  entries — the configured `label`, if any, would be ambiguous across multiple files so it's
 *  only honored for the single-file case). A glob object entry that matches nothing yields one
 *  error record (`label` = the entry's configured label or the pattern itself) so a stale
 *  config reads as such, not silence. An absolute glob path is not expanded — kept as the
 *  current literal single-file behavior — since expandKnowledgePattern's glob walk only
 *  supports root-relative trees. A non-glob source object still resolves to exactly one
 *  record for its file: `path` absolute or resolved against `root`, label defaulting to the
 *  basename, kind defaulting to 'markdown'; a missing file → an error record, never silence. */
async function collectKnowledgeEntry(
  targetName: string,
  root: string,
  entry: KnowledgeEntry,
): Promise<KnowledgeSourceRecord[]> {
  if (typeof entry === 'string') {
    const hits = (await expandKnowledgePattern(root, entry)).sort().slice(0, KNOWLEDGE_MAX_DOCS_PER_SOURCE);
    const records: KnowledgeSourceRecord[] = [];
    for (const rel of hits) {
      records.push(await readKnowledgeSource(targetName, join(root, rel), basename(rel), 'markdown', rel));
    }
    return records;
  }
  const kind = entry.kind ?? 'markdown';
  if (entry.path.includes('*') && !isAbsolute(entry.path)) {
    const hits = (await expandKnowledgePattern(root, entry.path)).sort().slice(0, KNOWLEDGE_MAX_DOCS_PER_SOURCE);
    if (!hits.length) {
      const label = entry.label ?? entry.path;
      return [{ targetName, label, path: entry.path, kind, content: '', error: 'no files matched' }];
    }
    const records: KnowledgeSourceRecord[] = [];
    for (const rel of hits) {
      records.push(await readKnowledgeSource(targetName, join(root, rel), basename(rel), kind, rel));
    }
    return records;
  }
  // Absolute path used as-is; relative resolves against the scope root (resolvePath handles
  // both). The display path stays as the operator configured it — their mental key.
  const abs = isAbsolute(entry.path) ? entry.path : resolvePath(root, entry.path);
  const label = entry.label ?? basename(entry.path);
  return [await readKnowledgeSource(targetName, abs, label, kind, entry.path)];
}

/**
 * Collect every configured knowledge source into flat KnowledgeSourceRecords: `paths`
 * against the plane repo root (grouped under the 'Plane repo' target name), each `targets`
 * entry against that target's registered repoPath (resolved through the fold's targets
 * registry by id or name). An entry naming an unregistered target yields an error record so
 * a stale config reads as such, not as silence. Returns undefined when no knowledge config
 * exists at all (→ the instructive empty state).
 */
async function collectKnowledge(
  cfg: KnowledgeConfig | undefined,
  result: FoldResult,
  repoRoot: string,
): Promise<KnowledgeSourceRecord[] | undefined> {
  if (!cfg) return undefined;
  const records: KnowledgeSourceRecord[] = [];
  for (const entry of cfg.paths ?? []) {
    records.push(...(await collectKnowledgeEntry('Plane repo', repoRoot, entry)));
  }
  for (const [name, entries] of Object.entries(cfg.targets ?? {})) {
    const target = result.targets.byId(name) ?? result.targets.byName(name);
    if (!target) {
      const label = typeof entries[0] === 'string' || entries[0] === undefined ? name : (entries[0].label ?? name);
      records.push({ targetName: name, label, path: name, kind: 'markdown', content: '', error: 'target not registered' });
      continue;
    }
    for (const entry of entries) {
      records.push(...(await collectKnowledgeEntry(target.name, target.repoPath, entry)));
    }
  }
  return records.length ? records : undefined;
}

/** Strictly path-validated artifact download: `targetSeg` must be '_' or a well-formed target
 *  id, `filename` must match the same WI-NNN-attempt-N.* convention the browse views render —
 *  no file outside that convention (and no traversal — both patterns forbid '/' and '..') is
 *  ever servable, regardless of what else lives under the runs directory. */
async function serveArtifact(
  res: ServerResponse,
  runsDir: string,
  targetSeg: string,
  filename: string,
): Promise<void> {
  const notFoundBody = notFoundPage(`/artifact/${targetSeg}/${filename}`);
  if (targetSeg !== '_' && !TARGET_ID_RE.test(targetSeg)) return send(res, 404, notFoundBody);
  if (!ARTIFACT_FILENAME_RE.test(filename)) return send(res, 404, notFoundBody);

  const dir = targetSeg === '_' ? runsDir : join(runsDir, targetSeg);
  const filePath = join(dir, filename);
  // Defense in depth: the regex checks above already forbid '/' and '..' in either segment,
  // so this can't fire in practice — kept as a second gate, mirroring serveStaticAsset's guard.
  if (!filePath.startsWith(runsDir)) return send(res, 404, notFoundBody);

  try {
    const body = await readFile(filePath, 'utf8');
    return send(res, 200, body, 'text/plain; charset=utf-8');
  } catch {
    return send(res, 404, notFoundBody);
  }
}

// ---------------------------------------------------------------------------
// Legacy-format attachment download (WI-055 item 2) — GET /attachment?id=<sourceId>&name=<file>.
//
// A LEGACY-format message (captured from an external bridge, not this console's own multipart
// uploads) records its attachments as `attachment: <source-id>/<file> (<N> bytes)` markers in
// the captured text (schema.ts's `resolveAttachmentPaths` reads the SAME markers to feed a
// build agent's prompt); the files themselves live under
// `<uploadsRoot>/<source-id>/<file>` where `uploadsRoot` = the `LOOPKIT_UPLOADS_ROOT` env var,
// else `<HOME>/.loopkit/uploads`. opsPages.ts's ThreadDetailProjection (adopted
// from @loopkit/opsui) already renders `<a href="/attachment?id=...&name=...">` / `<img
// src="...">` for every parsed attachment marker — this route is the one piece of that
// contract this package never wired up on its own (the download 404'd). The route mirrors
// `resolveAttachmentPaths`'s exact root-resolution rule (same env var, same fallback) rather
// than reusing that function directly — it resolves free-text markers into a list, not one
// id+name pair from query params, so a shared helper would be the wrong shape for either call
// site.
// ---------------------------------------------------------------------------

/** Same env-var precedence as schema.ts's `resolveAttachmentPaths` — kept in sync by the
 *  comment above rather than a shared helper (see rationale there). */
function uploadsRoot(env: NodeJS.ProcessEnv): string {
  const home = env['HOME'] ?? '';
  return env['LOOPKIT_UPLOADS_ROOT'] ?? (home ? `${home}/.loopkit/uploads` : '.loopkit/uploads');
}

/** A single filesystem path segment: non-empty, no `/` (or its encoded form is already decoded
 *  by the time this runs), no leading `.` (blocks `.`/`..`/dotfiles), and a conservative
 *  printable-ASCII charset — the same "no traversal, nothing exotic" bar `sanitizeAttachmentName`
 *  (this file, the upload-side counterpart) applies to a name before it's ever written to disk. */
const SAFE_PATH_SEGMENT_RE = /^[^/.][^/]{0,254}$/;

/** Best-effort content-type by extension for a legacy-format attachment — these were uploaded
 *  by an external bridge, not this server, so (unlike the console's own multipart uploads)
 *  there is no stored Content-Type to fall back on. Unknown extensions serve as a generic
 *  binary download rather than guessing wrong. */
const ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

/** Strictly path-validated legacy-attachment download: both `sourceId` and `name` must be a
 *  single safe path segment (no `/`, no `..`, no leading dot) — no file outside
 *  `<uploadsRoot>/<sourceId>/<name>` is ever servable, regardless of what else lives under the
 *  uploads root. Read-only; never lists the directory, never serves anything not named exactly
 *  by the two query params. */
async function serveAttachment(
  res: ServerResponse,
  env: NodeJS.ProcessEnv,
  sourceId: string,
  name: string,
): Promise<void> {
  const notFoundBody = notFoundPage(`/attachment?id=${sourceId}&name=${name}`);
  if (!SAFE_PATH_SEGMENT_RE.test(sourceId) || !SAFE_PATH_SEGMENT_RE.test(name)) {
    return send(res, 404, notFoundBody);
  }

  const root = resolvePath(uploadsRoot(env));
  const filePath = join(root, sourceId, name);
  // Defense in depth: the regex checks above already forbid '/' and '..' in either segment, so
  // this can't fire in practice — kept as a second gate, mirroring serveArtifact's own guard.
  if (!filePath.startsWith(root + '/')) return send(res, 404, notFoundBody);

  try {
    const body = await readFile(filePath);
    const contentType = ATTACHMENT_CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
    return sendBinary(res, 200, body, contentType);
  } catch {
    return send(res, 404, notFoundBody);
  }
}

// ---------------------------------------------------------------------------
// Live tail (SSE) — /item/<id>/live. Bounded and read-only: it never re-implements a verb, it
// only re-polls loadAllEvents (the same fold-source every GET route already reads) for msg.out
// events on one item that weren't present when the connection opened. Bounded on three sides so
// a forgotten browser tab can never hold a server connection or poll timer open indefinitely:
// closes the instant it forwards a reply, closes at LIVE_MAX_MS regardless, and stops all timers
// the moment the client disconnects.
// ---------------------------------------------------------------------------

const ITEM_LIVE_RE = /^\/item\/([A-Za-z0-9-]+)\/live$/;

/** Hard cap on connection lifetime — matches the "closes after reply or ~2min" bound. */
const LIVE_MAX_MS = 2 * 60 * 1000;
/** How often the tail re-checks the ledger for a new msg.out on this item. */
const LIVE_POLL_MS = 1000;
/** Comment-only keepalive so an idle connection isn't reaped by an intermediary proxy/timeout
 *  before LIVE_MAX_MS — SSE comments (lines starting `:`) are ignored by EventSource itself. */
const LIVE_HEARTBEAT_MS = 15_000;

/**
 * Tail one item's msg.out events over SSE. Never writes to the ledger; every tick just re-reads
 * it, same as any GET route. Baseline is taken at connect time so only events that land AFTER
 * the tab opened are ever forwarded — a reconnect never replays history the item page already
 * rendered server-side.
 */
async function serveItemLive(req: IncomingMessage, res: ServerResponse, ledgerDir: string, itemId: string): Promise<void> {
  let seen: Set<string>;
  try {
    const baseline = await loadAllEvents(ledgerDir);
    seen = new Set(baseline.filter((e) => e.item === itemId && e.type === 'msg.out').map((e) => e.id));
  } catch {
    seen = new Set();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearTimeout(maxTimer);
    res.end();
  };

  const poll = async (): Promise<void> => {
    if (closed) return;
    let events;
    try {
      events = await loadAllEvents(ledgerDir);
    } catch {
      return; // transient read failure — the next tick tries again, within LIVE_MAX_MS
    }
    for (const ev of events) {
      if (closed) return;
      if (ev.item !== itemId || ev.type !== 'msg.out' || seen.has(ev.id)) continue;
      seen.add(ev.id);
      const data = ev.data as unknown as MsgOutData;
      const payload = JSON.stringify({ id: ev.id, ts: ev.ts, text: data.text ?? '' });
      res.write(`event: reply\ndata: ${payload}\n\n`);
      // One reply is enough to consider this tail done — the client reloads to render the full
      // thread server-side rather than this route growing a client-side patch protocol.
      finish();
      return;
    }
  };

  const pollTimer = setInterval(() => void poll(), LIVE_POLL_MS);
  const heartbeatTimer = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, LIVE_HEARTBEAT_MS);
  const maxTimer = setTimeout(finish, LIVE_MAX_MS);

  req.on('close', finish);
}

function send(res: ServerResponse, status: number, body: string, contentType = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** Binary counterpart of `send` — a string body's Content-Length must be computed with
 *  `Buffer.byteLength`, which is correct for text but never for pre-encoded binary payloads
 *  like a woff2 font (case in point: this route). Takes the Buffer directly so its own byte
 *  length is authoritative and the body is written without any UTF-8 round-trip. */
function sendBinary(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

/** POST-redirect-GET: 303 back to `location` so a refresh never re-submits the form. */
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, 'Content-Length': '0' });
  res.end();
}

async function serveStaticAsset(res: ServerResponse, pathname: string): Promise<boolean> {
  const ext = extname(pathname);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return false;
  const publicDir = await publicDirPromise;
  const filePath = join(publicDir, pathname);
  if (!filePath.startsWith(publicDir)) return false; // guard against path traversal
  try {
    const body = await readFile(filePath, 'utf8');
    send(res, 200, body, contentType);
    return true;
  } catch {
    return false;
  }
}

let cachedUiComponentsCss: string | undefined;

/** `@loopkit/ui`'s authored `styles/components.css` — resolved relative to the package's own
 *  `package.json` (a workspace dependency, not published to npm registry) rather than assuming
 *  a fixed directory depth from this file, so the route survives both the real build layout
 *  and the test build layout. Cached after first read (the stylesheet is static per process). */
async function uiComponentsCss(): Promise<string | undefined> {
  if (cachedUiComponentsCss !== undefined) return cachedUiComponentsCss;
  try {
    const req = createRequire(import.meta.url);
    const uiPkgPath = req.resolve('@loopkit/ui/package.json');
    const cssPath = join(dirname(uiPkgPath), 'src', 'styles', 'components.css');
    cachedUiComponentsCss = await readFile(cssPath, 'utf8');
  } catch {
    cachedUiComponentsCss = '';
  }
  return cachedUiComponentsCss;
}

let cachedUiFontsCss: string | undefined;
let cachedUiFontWoff2: Buffer | undefined;

/** Resolve `@loopkit/ui`'s own package.json the same way `uiComponentsCss` does, so both the
 *  authored `canonical/fonts.css` (the `@font-face` rule) and the self-hosted
 *  `canonical/fonts/InterVariable.woff2` binary survive the real build layout and the test
 *  build layout without hardcoding a directory depth from this file. */
async function uiPackageDir(): Promise<string> {
  const req = createRequire(import.meta.url);
  const uiPkgPath = req.resolve('@loopkit/ui/package.json');
  return dirname(uiPkgPath);
}

/** `@loopkit/ui`'s authored `canonical/fonts.css` — the `@font-face` registering the
 *  self-hosted Inter variable font. Cached after first read (static per process, same as
 *  `uiComponentsCss`). */
async function uiFontsCss(): Promise<string | undefined> {
  if (cachedUiFontsCss !== undefined) return cachedUiFontsCss;
  try {
    const dir = await uiPackageDir();
    cachedUiFontsCss = await readFile(join(dir, 'canonical', 'fonts.css'), 'utf8');
  } catch {
    cachedUiFontsCss = '';
  }
  return cachedUiFontsCss;
}

/** `@loopkit/ui`'s self-hosted `canonical/fonts/InterVariable.woff2` — read as a Buffer (no
 *  encoding) since a woff2 is binary; a text read would corrupt it via UTF-8 decoding. Cached
 *  after first read. Returns undefined (never an empty Buffer) when the file is missing, so the
 *  route can tell "no font" apart from "empty file". */
async function uiFontWoff2(): Promise<Buffer | undefined> {
  if (cachedUiFontWoff2 !== undefined) return cachedUiFontWoff2;
  try {
    const dir = await uiPackageDir();
    cachedUiFontWoff2 = await readFile(join(dir, 'canonical', 'fonts', 'InterVariable.woff2'));
  } catch {
    return undefined;
  }
  return cachedUiFontWoff2;
}

// ---------------------------------------------------------------------------
// @loopkit/opsui asset serving (WI-053) — the design system's CSS + client JS,
// resolved via the package's own package.json (workspace dependency), mirroring the canonical
// console's serving scheme: tokens generated from source, components.css + the registered
// per-projection stylesheets, and the progressive-enhancement scripts from public/.
// ---------------------------------------------------------------------------

async function opsuiPackageDir(): Promise<string> {
  const req = createRequire(import.meta.url);
  return dirname(req.resolve('@loopkit/opsui/package.json'));
}

let cachedOpsuiComponentsCss: string | undefined;

/** components.css + every registered projection stylesheet, so a single fetch styles every
 *  projection (the canonical css-serving wire-up). */
async function opsuiComponentsCss(): Promise<string> {
  if (cachedOpsuiComponentsCss !== undefined) return cachedOpsuiComponentsCss;
  try {
    const pkgRoot = await opsuiPackageDir();
    const base = await readFile(join(pkgRoot, 'src', 'styles', 'components.css'), 'utf8');
    const extras = await Promise.all(
      registeredStylesheets().map(async (rel) => {
        try {
          return `\n/* ${rel} */\n` + (await readFile(join(pkgRoot, rel), 'utf8'));
        } catch {
          return '';
        }
      }),
    );
    cachedOpsuiComponentsCss = base + extras.join('');
  } catch {
    cachedOpsuiComponentsCss = '';
  }
  return cachedOpsuiComponentsCss;
}

let cachedOpsuiProjectionsCss: string | undefined;

/** All registered projection stylesheets concatenated — served at /ui/projections.css. */
async function opsuiProjectionsCss(): Promise<string> {
  if (cachedOpsuiProjectionsCss !== undefined) return cachedOpsuiProjectionsCss;
  try {
    const pkgDir = await opsuiPackageDir();
    const sheets = registeredStylesheets();
    const parts = await Promise.all(
      sheets.map((rel) => readFile(join(pkgDir, rel), 'utf8').catch(() => `/* missing: ${rel} */`)),
    );
    cachedOpsuiProjectionsCss = parts.join('\n');
  } catch {
    cachedOpsuiProjectionsCss = '';
  }
  return cachedOpsuiProjectionsCss;
}

const opsuiPublicCache = new Map<string, string>();

/** One of the design system's public/ client scripts (shell/composer/palette/confirm). */
async function opsuiPublicJs(name: string): Promise<string | undefined> {
  const cached = opsuiPublicCache.get(name);
  if (cached !== undefined) return cached;
  try {
    const pkgDir = await opsuiPackageDir();
    const body = await readFile(join(pkgDir, 'public', name), 'utf8');
    opsuiPublicCache.set(name, body);
    return body;
  } catch {
    return undefined;
  }
}

export interface ConsoleOptions {
  /** Directory containing the ledger's work-*.jsonl / ops-*.jsonl segments. */
  ledgerDir: string;
  /**
   * Repo root the plane builds against — used only by the approve verb's branch-existence
   * check (git rev-parse in this directory). Defaults to process.cwd(), matching the CLI.
   */
  repoRoot?: string;
  /** Port to listen on. Defaults to an ephemeral port (0). */
  port?: number;
  /**
   * Host to bind. Defaults to 127.0.0.1 (loopback-only) — the console now accepts writes,
   * so it must never bind a wider interface by accident.
   */
  host?: string;
  /**
   * Extra hostnames (no port) trusted as POST Hosts alongside loopback — for an
   * operator-controlled reverse proxy in front of the loopback bind (e.g. a private
   * mesh-VPN HTTPS hostname). The Origin↔Host match still applies; this only widens which
   * Hosts are acceptable. Leave empty unless you run such a proxy: each entry re-opens the
   * DNS-rebinding surface for that exact name, so list only names you control.
   */
  trustedHosts?: string[];
  /**
   * Directory the build-artifact browser (/system's "Recent artifacts", the item page's
   * Evidence card, and the /artifact download route) scans for on-disk attempt evidence.
   * Defaults to `resolvePlaneHome({ repoRoot }).runsDir` — the plane's own runs directory,
   * same resolution beats/dispatch.ts uses. Override in tests so a run never touches a real
   * operator's `~/.loopkit`.
   */
  runsDir?: string;
  /**
   * Directory whose git checkout backs the CSS/JS this server reads live off disk (see
   * `checkoutDriftError` above) — defaults to this module's own directory (the real checkout
   * serving those assets in production). Override in tests to point at a disposable repo
   * instead of asserting against whatever this monorepo checkout happens to be doing.
   */
  checkoutDir?: string;
  /**
   * Skip the checkout-drift guard entirely (see `checkoutDriftError` above). The guard already
   * allows the healthy ahead-of-origin state, so this is not needed to run a gate on an
   * unpushed checkout — it exists for tests that want to assert server behavior in isolation
   * from this monorepo checkout's git state altogether (e.g. a CI sandbox with no upstream
   * wiring, or a test that doesn't want any git subprocess in its critical path). Never set
   * this in production: it disables the only protection against silently serving stale
   * live-read CSS/JS.
   */
  skipCheckoutDriftCheck?: boolean;
}

export interface ConsoleHandle {
  server: Server;
  /** The port actually bound (useful when `port` was 0 / omitted). */
  port: number;
  close(): Promise<void>;
}

function notFound(req: IncomingMessage, res: ServerResponse): void {
  send(res, 404, notFoundPage(req.url ?? ''));
}

/**
 * Start the console HTTP server (four read views + four write verbs). Resolves once the
 * server is listening.
 */
export async function startConsole(opts: ConsoleOptions): Promise<ConsoleHandle> {
  const ledgerDir = opts.ledgerDir;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const host = opts.host ?? '127.0.0.1';
  const trustedHosts = new Set((opts.trustedHosts ?? []).map((h) => h.toLowerCase()));
  const runsDir = opts.runsDir ?? resolvePlaneHome({ repoRoot }).runsDir;

  const driftError = opts.skipCheckoutDriftCheck ? undefined : checkoutDriftError(opts.checkoutDir ?? __dirname);
  if (driftError) throw new Error(driftError);

  const server = createServer((req, res) => {
    void handleRequest(req, res, ledgerDir, repoRoot, trustedHosts, runsDir);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ledgerDir: string,
  repoRoot: string,
  trustedHosts: ReadonlySet<string>,
  runsDir: string,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const url = new URL(rawUrl, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'POST') {
      return await handlePost(req, res, pathname, url, ledgerDir, repoRoot, trustedHosts, runsDir);
    }

    // Method discipline: GET stays pure. Anything else (PUT/DELETE/...) is not a route here.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return notFound(req, res);
    }

    // Self-hosted Inter variable font — served before /ui-tokens.css and /ui-components.css
    // (both linked after it in html.ts's <head>) so the @font-face rule registers before the
    // token/component stylesheets' fractional weights (560/620/640/680) ever need to paint.
    if (pathname === '/ui-fonts.css') {
      const css = await uiFontsCss();
      if (!css) return notFound(req, res);
      return send(res, 200, css, 'text/css; charset=utf-8');
    }
    if (pathname === '/ui-fonts/InterVariable.woff2') {
      const woff2 = await uiFontWoff2();
      if (!woff2) return notFound(req, res);
      return sendBinary(res, 200, woff2, 'font/woff2');
    }
    if (pathname === '/ui-tokens.css') {
      return send(res, 200, generateTokensCss(), 'text/css; charset=utf-8');
    }
    // Web-app manifest: without it, a home-screen/dock install is a mere bookmark and every
    // navigation opens an in-app browser sheet instead of staying in the standalone shell.
    if (pathname === '/manifest.webmanifest') {
      return send(res, 200, JSON.stringify({
        name: 'loopkit console',
        short_name: 'loopkit',
        start_url: '/command',
        scope: '/',
        display: 'standalone',
        background_color: '#0b0e14',
        theme_color: '#0b0e14',
      }), 'application/manifest+json; charset=utf-8');
    }
    if (pathname === '/ui-components.css') {
      const css = await uiComponentsCss();
      if (!css) return notFound(req, res);
      return send(res, 200, css, 'text/css; charset=utf-8');
    }

    // WI-053: the design system's canonical CSS + client JS. Served before the
    // extname-based static branch below (these paths carry extensions but live in the opsui
    // package, not the console's public/ dir).
    if (pathname === '/ui/tokens.css') {
      return send(res, 200, opsuiGenerateTokensCss(), 'text/css; charset=utf-8');
    }
    if (pathname === '/ui/components.css') {
      return send(res, 200, await opsuiComponentsCss(), 'text/css; charset=utf-8');
    }
    if (pathname === '/ui/projections.css') {
      return send(res, 200, await opsuiProjectionsCss(), 'text/css; charset=utf-8');
    }
    const opsuiJsMatch = /^\/ui\/(shell|composer|palette|confirm|live)\.js$/.exec(pathname);
    if (opsuiJsMatch) {
      const body = await opsuiPublicJs(`opsui-${opsuiJsMatch[1] as string}.js`);
      if (body === undefined) return notFound(req, res);
      return send(res, 200, body, 'application/javascript; charset=utf-8');
    }

    // Build-artifact download — checked before the extname-based static-asset branch below,
    // since artifact filenames (e.g. `.log`, `.diff`) would otherwise fall into it and 404.
    const artifactMatch = /^\/artifact\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (artifactMatch) {
      return await serveArtifact(res, runsDir, artifactMatch[1] as string, artifactMatch[2] as string);
    }

    // Legacy-format attachment download (WI-055 item 2) — GET /attachment?id=<sourceId>&name=<file>,
    // the download contract opsPages.ts's ThreadDetailProjection already links to.
    if (pathname === '/attachment') {
      return await serveAttachment(res, process.env, url.searchParams.get('id') ?? '', url.searchParams.get('name') ?? '');
    }

    // Live tail (SSE) — GET only; HEAD falls through to notFound rather than opening a stream
    // no client will ever read.
    const itemLiveMatch = ITEM_LIVE_RE.exec(pathname);
    if (itemLiveMatch && req.method === 'GET') {
      return await serveItemLive(req, res, ledgerDir, itemLiveMatch[1] as string);
    }

    if (pathname !== '/' && extname(pathname)) {
      const served = await serveStaticAsset(res, pathname);
      if (served) return;
      return notFound(req, res);
    }

    // WI-053: one ledger read + fold + summary per GET (quarantine-aware, CLI parity).
    const data = await loadOpsData(ledgerDir, repoRoot);
    const { events, result } = data;
    const now = new Date();
    // ?theme= (the query-string selector) wins; the console's own theme cookie is the
    // fallback so the existing POST /theme toggle keeps working.
    const theme = url.searchParams.get('theme') ?? readCookie(req.headers.cookie, 'theme');
    const ctx: OpsPageContext = {
      ledgerDir,
      repoRoot,
      runsDir,
      runDir: join(runsDir, 'loopkit'),
      env: process.env,
    };

    if (pathname === '/' || pathname === '/needs-you') {
      return redirect(res, '/command');
    }

    // 301s for the retired re-implemented console paths (old bookmarks keep working).
    const MOVED: Record<string, string> = {
      '/missions': '/work',
      '/system': '/health',
      '/knowledge': '/company',
      '/analytics': '/observability',
    };
    const moved = MOVED[pathname];
    if (moved !== undefined) {
      res.writeHead(301, { Location: moved, 'Content-Length': '0' });
      res.end();
      return;
    }

    if (pathname === '/command') {
      const capturedId = url.searchParams.get('captured') ?? undefined;
      // ?page paginates the delivery stream; ?threadsPage the folded-in conversations region.
      const rawCmdPage = Number(url.searchParams.get('page') ?? '1');
      const cmdPage = Number.isFinite(rawCmdPage) && rawCmdPage >= 1 ? Math.floor(rawCmdPage) : 1;
      const rawThreadsPage = Number(url.searchParams.get('threadsPage') ?? '1');
      const threadsPage = Number.isFinite(rawThreadsPage) && rawThreadsPage >= 1 ? Math.floor(rawThreadsPage) : 1;
      return send(res, 200, renderCommandPage(data, ctx, capturedId, cmdPage, threadsPage, url.searchParams.get('window')));
    }

    if (pathname === '/work') {
      return send(res, 200, renderWorkPage(data, ctx, theme));
    }

    if (pathname === '/acceptance') {
      return send(res, 200, renderAcceptancePage(data, theme, url.searchParams.get('filter')));
    }

    if (pathname === '/health') {
      return send(res, 200, renderHealthPage(data, ctx, theme, url.searchParams.get('window')));
    }

    if (pathname === '/company') {
      const sources = await collectKnowledge(data.cfg.knowledge, data.result, repoRoot);
      return send(res, 200, renderCompanyPage(data, theme, sources, url.searchParams.get('target')));
    }

    if (pathname === '/observability') {
      return send(res, 200, renderObservabilityPage(data, ctx, theme));
    }

    // /threads/WI-NNN 301s to the canonical item hub — checked BEFORE the generic
    // thread-detail match so a WI id never falls through to "thread not found".
    const threadWiRedirect = /^\/threads\/(WI-\d+)$/.exec(pathname);
    if (threadWiRedirect) {
      res.writeHead(301, { Location: `/item/${threadWiRedirect[1] as string}`, 'Content-Length': '0' });
      res.end();
      return;
    }

    const threadDetailMatch = /^\/threads\/([A-Z]+-\d+)$/.exec(pathname);
    if (threadDetailMatch) {
      return send(res, 200, renderThreadDetailPage(data, threadDetailMatch[1] as string, theme));
    }

    if (pathname === '/threads') {
      const rawPage = Number(url.searchParams.get('page') ?? '1');
      const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
      return send(res, 200, renderThreadsPage(data, page, theme));
    }

    if (pathname === '/timeline') {
      const itemParam = url.searchParams.get('item') ?? '';
      if (itemParam && !/^WI-\d+$/.test(itemParam)) {
        return send(res, 400, 'item must be a WI-NNN identifier', 'text/plain; charset=utf-8');
      }
      // A per-item timeline is the item hub's Timeline region — 301 to the canonical page.
      if (itemParam) {
        res.writeHead(301, { Location: `/item/${itemParam}`, 'Content-Length': '0' });
        res.end();
        return;
      }
      return send(res, 200, renderTimelinePage(data, theme));
    }

    if (pathname === '/activity') {
      return send(res, 200, renderActivityPage(data, now, theme, url));
    }

    // Item hub — the canonical per-item page for WI-NNN ids.
    const itemHubMatch = /^\/item\/(WI-\d+)$/.exec(pathname);
    if (itemHubMatch) {
      return send(res, 200, renderItemHubPage(data, ctx, itemHubMatch[1] as string, theme));
    }

    // Legacy/other item ids (e.g. CONV-N) keep the plain item timeline view.
    const itemMatch = /^\/item\/([A-Za-z0-9-]+)$/.exec(pathname);
    if (itemMatch) {
      const itemId = itemMatch[1] as string;
      const artifacts = await listArtifacts(runsDir);
      return send(res, 200, renderItemTimeline(itemId, result.items.get(itemId), events, now, result, readCookie(req.headers.cookie, 'theme'), url, artifacts));
    }

    // OpsData is already loaded at this point (line ~846) — render the 404 on the same shared
    // opsui shell every other route uses (WI-055 item 1), not the pre-WI-053 html.ts chrome.
    return send(res, 404, renderNotFoundPage(data, pathname, theme));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, 500, `<pre>Internal error: ${message.replace(/[<>&]/g, '')}</pre>`);
  }
}

// ---------------------------------------------------------------------------
// Write verbs (POST)
// ---------------------------------------------------------------------------

const POST_ROUTES = new Set(['/intent', '/theme']);

// ---------------------------------------------------------------------------
// Deterministic verb regexes (WI-053) — the exact
// patterns the markup's approve/decline/resolve/accept/run-control buttons POST
// as intent text. Matched intents call the shared core verb functions directly (same lock
// discipline as the /item/<id>/<verb> handlers), never the capture path — zero LLM.
// ---------------------------------------------------------------------------

/** Exact pattern emitted by the approve/reject buttons on spine-parked decision cards. */
const SPINE_VERB_RE = /^🛡 spine ([\w-]+): (approve|reject)$/u;
/** Pattern emitted by the approve/decline buttons for non-spine parked items. */
const PARKED_VERB_RE = /^▶ parked ([\w-]+): (approve|decline)$/u;
/** Resolve button on building/queued/parked work rows — operator force-dismiss (terminal). */
const RESOLVE_VERB_RE = /^✔ resolve ([\w-]+)$/u;
/** Accept button on merged/delivery-stream cards — the one legit post-merge transition. */
const ACCEPT_VERB_RE = /^✅ accept ([\w-]+)$/u;
/** Confirm-gated Stop button on an in-flight run card. */
const STOP_VERB_RE = /^⏹ stop ([\w-]+)$/u;
/** Escalate: send any active item to the operator's decision desk. */
const ESCALATE_VERB_RE = /^🛎 escalate ([\w-]+)$/u;
/** Hold: park a queued item with no build in flight. */
const HOLD_VERB_RE = /^⏸ hold ([\w-]+)$/u;
/** Resume: unpark a held item back to queued. */
const RESUME_VERB_RE = /^▶ resume ([\w-]+)$/u;
/** Retry with an explicit model override — model restricted to known builder aliases. */
const RETRY_VERB_RE = /^🔁 retry ([\w-]+): (sonnet|opus|haiku)$/u;

/** Retry-with-other-model: item.unparked + item.queued (spec/touches reused, model override)
 *  + the trail message — the same event trio, written through the shared single-writer lock. */
async function retryWithModel(ledgerDir: string, rawId: string, model: string, trailText: string): Promise<void> {
  await withLock(ledgerDir, async (tx) => {
    const allEvents = await tx.loadAll();
    const folded = fold(allEvents);
    const rec = folded.items.get(rawId);
    await tx.append([
      makeEvent('operator', rawId, 'item.unparked', { by: 'founder' }),
      makeEvent('operator', rawId, 'item.queued', {
        spec: rec?.spec ?? rec?.sourceText ?? '',
        ...(rec?.touches ? { touches: rec.touches } : {}),
        model,
      }),
      makeEvent('operator', rawId, 'msg.in', { text: trailText }),
    ]);
  });
}

/**
 * Try the deterministic verb patterns against a submitted intent text. When one matches, the
 * verb is executed and the page the canonical routes redirected to is returned; undefined
 * means "not a verb — capture it". VerbErrors propagate to the caller (→ 400 error page).
 */
async function applyDeterministicVerb(text: string, ledgerDir: string, repoRoot: string): Promise<string | undefined> {
  let m: RegExpExecArray | null;
  if ((m = SPINE_VERB_RE.exec(text))) {
    await approveOrReject(ledgerDir, m[1] as string, m[2] as 'approve' | 'reject', { repoRoot, trail: text });
    return '/command';
  }
  if ((m = PARKED_VERB_RE.exec(text))) {
    await approveOrReject(ledgerDir, m[1] as string, m[2] === 'approve' ? 'approve' : 'reject', { repoRoot, trail: text });
    return '/command';
  }
  if ((m = RESOLVE_VERB_RE.exec(text))) {
    await approveOrReject(ledgerDir, m[1] as string, 'reject', { repoRoot, by: 'founder resolve (no further action)', trail: text });
    return '/work';
  }
  if ((m = ACCEPT_VERB_RE.exec(text))) {
    await acceptItem(ledgerDir, m[1] as string, { trail: text });
    return '/command';
  }
  if ((m = STOP_VERB_RE.exec(text))) {
    await stopBuild(ledgerDir, m[1] as string);
    return '/work';
  }
  if ((m = ESCALATE_VERB_RE.exec(text))) {
    await escalateItem(ledgerDir, m[1] as string);
    return '/work';
  }
  if ((m = HOLD_VERB_RE.exec(text))) {
    await holdItem(ledgerDir, m[1] as string);
    return '/work';
  }
  if ((m = RESUME_VERB_RE.exec(text))) {
    await unparkItem(ledgerDir, m[1] as string, 'resume');
    return '/work';
  }
  if ((m = RETRY_VERB_RE.exec(text))) {
    await retryWithModel(ledgerDir, m[1] as string, m[2] as string, text);
    return '/work';
  }
  return undefined;
}
const ITEM_VERB_RE = /^\/item\/([A-Za-z0-9-]+)\/(approve|reject|accept|stop|hold|resume|requeue|escalate|dismiss)$/;
const ITEM_REPLY_RE = /^\/item\/([A-Za-z0-9-]+)\/reply$/;
const ITEM_FEEDBACK_RE = /^\/item\/([A-Za-z0-9-]+)\/feedback$/;
const THEME_VALUES = new Set(['light', 'dark']);

/**
 * CSRF/origin guard: the server binds loopback, but any page open in the
 * operator's browser can still POST to http://127.0.0.1:<port> — the browser will attach
 * cookies/credentials automatically and localhost has no same-origin protection of its own.
 * Reject any POST whose Origin (or Referer fallback, for older/plainer clients) host does not
 * match the request's own Host header. A same-origin form submission always carries a
 * same-host Origin; a cross-site page's form does not.
 *
 * The Host itself must also be a loopback literal: with an Origin↔Host match alone, a DNS
 * rebinding page (evil.example resolving to 127.0.0.1) satisfies the check — its Origin and
 * Host both read evil.example. A loopback-only Host closes that hole for a server that is
 * loopback-bound by design. `trustedHosts` (ConsoleOptions) widens ONLY this hostname check —
 * for an operator-controlled reverse proxy — never the Origin↔Host match itself.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isTrustedHost(hostHeader: string, trustedHosts: ReadonlySet<string>): boolean {
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return LOOPBACK_HOSTNAMES.has(hostname) || trustedHosts.has(hostname);
  } catch {
    return false;
  }
}

function originAllowed(req: IncomingMessage, trustedHosts: ReadonlySet<string>): boolean {
  const hostHeader = req.headers.host;
  if (!hostHeader) return false;
  if (!isTrustedHost(hostHeader, trustedHosts)) return false;

  const originHeader = req.headers.origin;
  const refererHeader = req.headers.referer;
  const sourceHeader = originHeader ?? refererHeader;
  // No Origin AND no Referer: a same-origin <form> POST always sends at least one of these
  // in every modern browser — absence of both is refused rather than trusted.
  if (!sourceHeader) return false;

  try {
    const sourceHost = new URL(sourceHeader).host;
    return sourceHost === hostHeader;
  } catch {
    return false;
  }
}

/** Read the request body up to `cap` bytes. Throws 'too-large' when the cap is exceeded. */
async function readBodyBuffer(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > cap) {
      throw new Error('too-large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Read the request body up to MAX_BODY_BYTES. Throws 'too-large' when the cap is exceeded. */
async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBodyBuffer(req, MAX_BODY_BYTES)).toString('utf8');
}

function parseFormBody(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

// ---------------------------------------------------------------------------
// Multipart form parsing (intent-composer attachments) — the composer posts
// enctype=multipart/form-data so a phone operator can drop a screenshot with a bug report.
// Bounded and dependency-free: the whole body is capped, parsed in memory, and only the
// /intent route ever consumes file parts.
// ---------------------------------------------------------------------------

/** Multipart body cap — comfortably fits a couple of phone screenshots, bounds abuse. */
const MAX_MULTIPART_BODY_BYTES = 8 * 1024 * 1024;
/** Files stored per POST (capture or reply) — the composer is a bug-report box, not a file share. */
const MAX_ATTACHMENTS_PER_POST = 5;

interface MultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Extract the boundary token from a multipart/form-data content-type header. */
function multipartBoundary(contentType: string): string | undefined {
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m?.[1] ?? m?.[2];
}

/**
 * Minimal RFC 2046 multipart/form-data parser: split on the boundary delimiter, read each
 * part's Content-Disposition for the field name (and filename, for file parts). Text parts
 * land in `fields`; file parts (any part carrying a filename) land in `files` with their raw
 * bytes. Malformed parts are skipped rather than 500ing the POST — the caller still gets
 * every well-formed field.
 */
function parseMultipart(body: Buffer, boundary: string): { fields: URLSearchParams; files: MultipartFile[] } {
  const fields = new URLSearchParams();
  const files: MultipartFile[] = [];
  const delimiter = Buffer.from(`--${boundary}`);

  let offset = body.indexOf(delimiter);
  while (offset !== -1) {
    const partStart = offset + delimiter.length;
    // Closing delimiter: `--boundary--`.
    if (body.slice(partStart, partStart + 2).toString('latin1') === '--') break;
    const next = body.indexOf(delimiter, partStart);
    const rawPart = next === -1 ? body.slice(partStart) : body.slice(partStart, next);
    offset = next;

    // Each part: CRLF, headers, CRLF CRLF, content, CRLF (before the next delimiter).
    const headerEnd = rawPart.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = rawPart.slice(0, headerEnd).toString('utf8');
    let content = rawPart.slice(headerEnd + 4);
    if (content.slice(-2).toString('latin1') === '\r\n') content = content.slice(0, -2);

    const disposition = /content-disposition:[^\r\n]*/i.exec(headerText)?.[0] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) continue;
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    if (filename !== undefined) {
      const contentType = /content-type:\s*([^\r\n;]+)/i.exec(headerText)?.[1]?.trim() ?? 'application/octet-stream';
      files.push({ fieldName: name, filename, contentType, data: content });
    } else {
      fields.append(name, content.toString('utf8'));
    }
  }
  return { fields, files };
}

/** Filesystem-safe attachment basename: strip any path, keep [A-Za-z0-9._-], never
 *  dot-leading, bounded length. */
function sanitizeAttachmentName(filename: string): string {
  const base = basename(filename).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return (base || 'attachment').slice(0, 80);
}

/**
 * Store one uploaded file under the plane's runs/attachments directory and return its
 * runs-dir-relative path (`attachments/<unique>-<name>`) — the path shape recorded on the
 * captured item. The unique prefix rules out collisions and traversal alike (the stored name
 * is never trusted input beyond its sanitized basename).
 */
async function storeAttachment(runsDir: string, file: MultipartFile): Promise<string> {
  const dir = join(runsDir, 'attachments');
  await mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}-${sanitizeAttachmentName(file.filename)}`;
  await writeFile(join(dir, name), file.data);
  return `attachments/${name}`;
}

/** Store every `attachment`-named file part (capped in count), shared by `/intent` and
 *  `/item/<id>/reply` — the one place either route turns multipart file parts into stored
 *  runs-dir-relative paths. */
async function collectAttachments(runsDir: string, files: MultipartFile[]): Promise<string[]> {
  const attachments: string[] = [];
  for (const file of files.filter((f) => f.fieldName === 'attachment' && f.data.length > 0).slice(0, MAX_ATTACHMENTS_PER_POST)) {
    attachments.push(await storeAttachment(runsDir, file));
  }
  return attachments;
}

/**
 * Render a write-verb failure page on the shared opsui shell (WI-055 item 1) — same chrome
 * every GET route uses. `loadData` is a lazy, memoized OpsData loader: a write POST that
 * succeeds never pays for a ledger read+fold just to render an error page it doesn't need, but
 * a POST that fails against several checks in sequence (e.g. the state pre-check then a verb's
 * own VerbError) only reloads OpsData once, on first use.
 */
function postErrorPage(loadData: () => Promise<OpsData>, req: IncomingMessage, message: string, backHref: string): Promise<string> {
  const theme = readCookie(req.headers.cookie, 'theme');
  return loadData().then((data) => renderErrorPage(data, message, backHref, theme));
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  ledgerDir: string,
  repoRoot: string,
  trustedHosts: ReadonlySet<string>,
  runsDir: string,
): Promise<void> {
  let cachedData: OpsData | undefined;
  const loadData = async (): Promise<OpsData> => {
    if (!cachedData) cachedData = await loadOpsData(ledgerDir, repoRoot);
    return cachedData;
  };

  const itemMatch = ITEM_VERB_RE.exec(pathname);
  const replyMatch = ITEM_REPLY_RE.exec(pathname);
  const feedbackMatch = ITEM_FEEDBACK_RE.exec(pathname);
  if (!POST_ROUTES.has(pathname) && !itemMatch && !replyMatch && !feedbackMatch) {
    return notFound(req, res);
  }

  if (!originAllowed(req, trustedHosts)) {
    return send(res, 403, '<pre>403 Forbidden: origin/referer does not match this host.</pre>');
  }

  // The intent composer posts multipart/form-data (file attachments); every other operator
  // form stays urlencoded. Multipart gets the raised — still bounded — body cap; the
  // urlencoded cap is unchanged.
  const contentType = req.headers['content-type'] ?? '';
  const boundary = /^multipart\/form-data/i.test(contentType) ? multipartBoundary(contentType) : undefined;
  let form: URLSearchParams;
  let files: MultipartFile[] = [];
  try {
    if (boundary) {
      const buf = await readBodyBuffer(req, MAX_MULTIPART_BODY_BYTES);
      ({ fields: form, files } = parseMultipart(buf, boundary));
    } else {
      form = parseFormBody(await readBody(req));
    }
  } catch {
    return send(res, 413, '<pre>413 Payload Too Large</pre>');
  }
  // EventRow-rendered verb actions (Command/Missions/Acceptance) carry `returnTo` on the form's
  // own action URL query string (EventAction.form has no separate returnTo slot); the plain
  // verbForm() helper (item timeline) still carries it as a hidden field. Query string wins
  // when both are present — it's the one the action URL was actually built with.
  // The opsui markup's forms carry `?next=` (its own return-path
  // convention); the console's own forms carry `returnTo`. Same validation, either name.
  const returnTo = safeReturnTo(
    url.searchParams.get('returnTo') ?? url.searchParams.get('next') ?? form.get('returnTo'),
  );

  if (pathname === '/intent') {
    // ONE field read point for the capture text: the design system's IntentComposer posts
    // `intent`, plainer forms (and the CLI-shaped tests) post `text` — both are the same verb.
    const text = (form.get('intent') ?? form.get('text') ?? '').trim();
    const target = form.get('target') || undefined;
    if (!text) return redirect(res, returnTo ?? '/command');

    // Deterministic verb short-circuit (WI-053): a matched verb pattern executes the shared
    // core verb directly and never reaches the capture path — zero LLM, same as the canonical
    // console's /intent handler.
    try {
      const verbNext = await applyDeterministicVerb(text, ledgerDir, repoRoot);
      if (verbNext !== undefined) {
        return redirect(res, returnTo ?? verbNext);
      }
    } catch (e) {
      if (e instanceof VerbError) {
        return send(res, 400, await postErrorPage(loadData, req, e.message, returnTo ?? '/command'));
      }
      throw e;
    }

    // Store attachments (multipart file parts) under the plane's runs/attachments dir, capped
    // in count and — via the body cap — in bytes. Stored only once the capture has text: a
    // blank submit must not shed orphan files.
    const attachments = await collectAttachments(runsDir, files);

    let wiId: string;
    try {
      const captureOpts: CaptureIntentOptions = {
        text,
        source: 'ext:console',
        target,
        ...(attachments.length ? { attachments } : {}),
      };
      const result = await captureIntent(ledgerDir, captureOpts);
      wiId = result.wiId;
    } catch (e) {
      if (e instanceof VerbError) {
        return send(res, 400, await postErrorPage(loadData, req, e.message, returnTo ?? '/command'));
      }
      throw e;
    }
    const base = returnTo ?? '/command';
    const sep = base.includes('?') ? '&' : '?';
    return redirect(res, `${base}${sep}captured=${encodeURIComponent(wiId)}`);
  }

  if (pathname === '/theme') {
    const theme = form.get('theme');
    const value = theme && THEME_VALUES.has(theme) ? theme : 'dark';
    res.setHeader('Set-Cookie', `theme=${value}; Path=/; SameSite=Lax; Max-Age=31536000`);
    return redirect(res, returnTo ?? '/command');
  }

  if (replyMatch) {
    const itemId = replyMatch[1] as string;
    const back = returnTo ?? `/item/${encodeURIComponent(itemId)}`;
    const text = (form.get('text') ?? '').trim();
    if (!text) return redirect(res, back);
    // Same rule as /intent: files are stored only once the reply has text, so a blank submit
    // never sheds orphan attachments.
    const attachments = await collectAttachments(runsDir, files);
    try {
      await replyToItem(ledgerDir, itemId, { text, ...(attachments.length ? { attachments } : {}) });
    } catch (e) {
      if (e instanceof VerbError) {
        return send(res, 400, await postErrorPage(loadData, req, e.message, back));
      }
      throw e;
    }
    return redirect(res, back);
  }

  if (feedbackMatch) {
    const itemId = feedbackMatch[1] as string;
    const back = returnTo ?? `/item/${encodeURIComponent(itemId)}`;
    const text = (form.get('text') ?? '').trim();
    if (!text) return redirect(res, back);
    // Same rule as /reply: files are stored only once the feedback has text, so a blank submit
    // never sheds orphan attachments.
    const attachments = await collectAttachments(runsDir, files);
    try {
      await captureFeedback(ledgerDir, itemId, { text, ...(attachments.length ? { attachments } : {}) });
    } catch (e) {
      if (e instanceof VerbError) {
        return send(res, 400, await postErrorPage(loadData, req, e.message, back));
      }
      throw e;
    }
    return redirect(res, back);
  }

  if (itemMatch) {
    const itemId = itemMatch[1] as string;
    const verb = itemMatch[2] as 'approve' | 'reject' | 'accept' | 'stop' | 'hold' | 'resume' | 'requeue' | 'escalate' | 'dismiss';
    const back = returnTo ?? `/item/${encodeURIComponent(itemId)}`;

    // State pre-check (read-only): the shared verbs stay deliberately permissive for CLI use,
    // but a POSTed form should only act on the state it was rendered against — a stale tab
    // must get a plain error page (with a way back), never a silent append or a silent no-op
    // dressed up as success. The check re-folds outside the verb's lock; the verbs' own
    // state guards still hold on their locked re-read.
    const rec = resolveItemRecord(fold(await loadAllEvents(ledgerDir)), itemId);
    if (!rec) {
      return send(res, 404, await postErrorPage(loadData, req, `No such item: ${itemId}. Nothing in the ledger is keyed by that id.`, back));
    }
    const stateError = runControlStateError(verb, rec);
    if (stateError) {
      return send(res, 409, await postErrorPage(loadData, req, stateError, back));
    }

    try {
      switch (verb) {
        case 'accept':
          await acceptItem(ledgerDir, itemId);
          break;
        case 'approve':
        case 'reject':
          await approveOrReject(ledgerDir, itemId, verb, { repoRoot });
          break;
        case 'stop':
          await stopBuild(ledgerDir, itemId);
          break;
        case 'hold':
          await holdItem(ledgerDir, itemId);
          break;
        case 'resume':
        case 'requeue':
          await unparkItem(ledgerDir, itemId, verb);
          break;
        case 'escalate':
          await escalateItem(ledgerDir, itemId);
          break;
        case 'dismiss':
          await dismissItem(ledgerDir, itemId);
          break;
      }
    } catch (e) {
      if (e instanceof VerbError) {
        return send(res, 400, await postErrorPage(loadData, req, e.message, back));
      }
      throw e;
    }
    return redirect(res, back);
  }

  return notFound(req, res);
}

function resolveItemRecord(result: FoldResult, rawId: string): ItemRecord | undefined {
  return result.items.get(rawId);
}

/** Same read-only-precheck contract as the comment above: one message per verb naming exactly
 *  which state(s) it applies to, else undefined when `rec` is in bounds for `verb`. */
function runControlStateError(verb: string, rec: ItemRecord): string | undefined {
  switch (verb) {
    case 'accept':
      return rec.state === 'merged' ? undefined
        : `${rec.id} is not awaiting acceptance (state: ${rec.state}) — only a merged item can be accepted.`;
    case 'approve':
    case 'reject':
      return rec.state === 'parked' ? undefined
        : `${rec.id} is not parked (state: ${rec.state}) — approve/reject apply to parked items only.`;
    case 'stop':
      return rec.state === 'building' ? undefined
        : `${rec.id} is not building (state: ${rec.state}) — stop applies to building items only.`;
    case 'hold':
      return rec.state === 'queued' ? undefined
        : `${rec.id} is not queued (state: ${rec.state}) — hold applies to queued items only.`;
    case 'resume':
      return isHeldPark(rec) ? undefined
        : `${rec.id} is not held (state: ${rec.state}, kind: ${rec.parkKind ?? 'none'}) — resume applies to held items only.`;
    case 'requeue':
      return isOpsPark(rec) ? undefined
        : `${rec.id} is not an ops-park (state: ${rec.state}, kind: ${rec.parkKind ?? 'none'}) — requeue applies to ops-parked items only.`;
    case 'escalate':
      return rec.state === 'building' || rec.state === 'queued' ? undefined
        : `${rec.id} is not building or queued (state: ${rec.state}) — escalate applies to active work only.`;
    case 'dismiss':
      return isOpsPark(rec) ? undefined
        : `${rec.id} is not an ops-park (state: ${rec.state}, kind: ${rec.parkKind ?? 'none'}) — dismiss applies to ops-parked items only.`;
    default:
      return undefined;
  }
}

/** Only ever redirect back to a path on this same server — never an operator-supplied URL. */
function safeReturnTo(value: string | null): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith('/') || value.startsWith('//')) return undefined;
  return value;
}
