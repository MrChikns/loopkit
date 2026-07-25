/**
 * fakeWorker.ts — shared lane-test helper (ADR-010 point 5).
 *
 * "A fake worker in a lane test may write files only, never commit — when the lane's
 * contract is commitMode: 'dispatch' (the system is supposed to commit; if the fake does
 * it, nothing is tested)." This factory is the default way to get that fake so a future
 * lane test gets the constraint by construction rather than by remembering it: writing
 * files (and optionally a worker manifest) is all `run()` does — there is no code path in
 * here that could ever shell out to `git add`/`git commit`.
 *
 * For a `commitMode: 'worker'` lane (the conductor — a human is present, the worker
 * committing IS the contract) this helper is the wrong tool: that fake legitimately
 * commits, and the test must instead assert the PROMPT instructed it to (see
 * conductor.test.ts). Reach for this helper only for dispatch-side-commit lanes.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { LlmProvider, ProviderRequest, ProviderResult } from '../src/providers/types.js';

export interface NonCommittingWorkerFile {
  /** Path relative to the worker's cwd (req.cwd). */
  path: string;
  contents: string;
}

export interface WorkerManifest {
  wi: string;
  filesTouched: string[];
  testsAdded?: string[];
  confidence?: number;
  notes?: string;
  /** Picked up by dispatch's scoped-commit as the commit message subject. */
  subject?: string;
}

/** Default judge-output grammar (see judge.ts's buildJudgePrompt/parseJudgeOutput) returned for
 *  a judge call (no req.cwd) so it parses to a REAL verdict rather than falling through to the
 *  generic build `resultText` — which is not judge grammar and would parse as 'unparseable',
 *  proving only that an event got recorded, not that a real verdict travelled the pipe intact. */
const DEFAULT_JUDGE_VERDICT_TEXT =
  'VERDICT: pass\nCONFIDENCE: 0.9\nSPEC_SATISFIED: yes\nSCOPE_CREEP: none\nTEST_THEATRE: none\n' +
  'REASONS:\n- fake-no-commit judge stub: default pass';

export interface NonCommittingWorkerOptions {
  /** Files to write into req.cwd on every call. */
  files: NonCommittingWorkerFile[];
  /** Optional worker manifest — written as MANIFEST-<wi>.json, same shape dispatch's
   *  scoped-commit reads for its commit subject. */
  manifest?: WorkerManifest;
  /** Text returned as the provider's result for a BUILD call (req.cwd set). Default: 'done'. */
  resultText?: string;
  /** Text returned for a JUDGE call (no req.cwd) — must be judge-output grammar (see judge.ts's
   *  buildJudgePrompt) to parse as a real verdict. Default: DEFAULT_JUDGE_VERDICT_TEXT (a
   *  parseable VERDICT: pass). */
  judgeResultText?: string;
  /** Usage figures returned for a JUDGE call. Present only when the caller wants to assert the
   *  resulting `cost.usage{loop:'judge'}` ledger event (dispatch.ts's judgeVerdictEvents appends
   *  it only when the provider result carries `usage`). Omitted by default — same as a build
   *  call's `resultText`, no usage is fabricated unless asked for. */
  judgeUsage?: { in: number; out: number; usd?: number; turns?: number; durationMs?: number };
  /** Provider name (cost.usage events, config maps). Default: 'fake-no-commit'. */
  name?: string;
  /** Optional hook to run extra assertions against the request before writing files
   *  (e.g. asserting req.tools carries no commit tool for this lane). Thrown assertions
   *  propagate — node:test fails the calling test. Only invoked for build calls (req.cwd
   *  set) — a lane's cwd-less judge reuse of this same provider never runs it, so the hook
   *  never needs to defensively check req.cwd itself. */
  assertRequest?: (req: ProviderRequest) => void;
}

/**
 * A fake `LlmProvider` whose `run()` writes files (and, optionally, a worker manifest)
 * into `req.cwd` and returns — never calling `git add`/`git commit`. Use this for any
 * `commitMode: 'dispatch'` lane test (target lane, batch/engineering lane): the assertion
 * that the SYSTEM produced a commit is only real if the fake could not have produced it
 * itself.
 *
 * The SAME provider instance is commonly reused by the calling lane for its post-build judge
 * call (`runJudge` always sends `{ tools: [], no cwd }` — see judge.ts). That call is handled
 * as its OWN explicit branch below (not an accidental fallthrough of the build path, which
 * would either throw — e.g. joining `undefined` into a path, or invoking a build-only
 * `assertRequest` hook against a request shape that structurally cannot satisfy it — or
 * silently no-op into generic build `resultText`, which is not judge grammar and parses as
 * 'unparseable'). It returns real, parseable judge-output grammar by default, so a test
 * asserting on the resulting `review.verdict` event is checking a genuine parsed verdict, not
 * a provider-error fail-open (`verdict: 'unavailable'`) or an incidental 'unparseable'.
 */
export function makeNonCommittingWorker(opts: NonCommittingWorkerOptions): LlmProvider {
  return {
    name: opts.name ?? 'fake-no-commit',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      const cwd = req.cwd;
      if (!cwd) {
        // Judge call: explicit, well-behaved handling — never crash the calling lane's
        // fail-open handling, and never skip the build-only assertRequest hook by falling
        // through into logic that assumes a cwd exists.
        return {
          ok: true,
          text: opts.judgeResultText ?? DEFAULT_JUDGE_VERDICT_TEXT,
          ...(opts.judgeUsage ? { usage: opts.judgeUsage } : {}),
        };
      }
      opts.assertRequest?.(req);
      for (const f of opts.files) {
        const full = join(cwd, f.path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, f.contents, 'utf8');
      }
      if (opts.manifest) {
        writeFileSync(join(cwd, `MANIFEST-${opts.manifest.wi}.json`), JSON.stringify(opts.manifest), 'utf8');
      }
      // Deliberately no git add / git commit anywhere in this function — the whole point.
      return { ok: true, text: opts.resultText ?? 'done' };
    },
  };
}
