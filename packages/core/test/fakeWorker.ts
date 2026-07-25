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

export interface NonCommittingWorkerOptions {
  /** Files to write into req.cwd on every call. */
  files: NonCommittingWorkerFile[];
  /** Optional worker manifest — written as MANIFEST-<wi>.json, same shape dispatch's
   *  scoped-commit reads for its commit subject. */
  manifest?: WorkerManifest;
  /** Text returned as the provider's result. Default: 'done'. */
  resultText?: string;
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
 */
export function makeNonCommittingWorker(opts: NonCommittingWorkerOptions): LlmProvider {
  return {
    name: opts.name ?? 'fake-no-commit',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      // The provider interface's own contract is "NEVER throws — always returns a
      // ProviderResult" (providers/types.ts); a lane may reuse this same provider for a
      // later non-build call (e.g. dispatch's post-merge judge review) that carries no
      // cwd. Writing nothing and returning ok is the well-behaved no-op for that case —
      // it must never crash the calling lane's fail-open handling. `assertRequest` is a
      // build-request assertion (its examples all read req.cwd/req.tools as if a build is
      // in progress), so it is gated the same way: skipping it on the cwd-less reuse means
      // a caller's hook never has to defensively guard against a call it didn't ask for.
      const cwd = req.cwd;
      if (cwd) {
        opts.assertRequest?.(req);
        for (const f of opts.files) {
          const full = join(cwd, f.path);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, f.contents, 'utf8');
        }
        if (opts.manifest) {
          writeFileSync(join(cwd, `MANIFEST-${opts.manifest.wi}.json`), JSON.stringify(opts.manifest), 'utf8');
        }
      }
      // Deliberately no git add / git commit anywhere in this function — the whole point.
      return { ok: true, text: opts.resultText ?? 'done' };
    },
  };
}
