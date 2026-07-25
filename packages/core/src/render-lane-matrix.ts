/**
 * render-lane-matrix.ts — writes `docs/lane-matrix.md` from the live, derived lane × guard
 * matrix (ADR-010 point 6, `docs/decisions/ADR-010-one-lane.md`). The matrix logic itself lives
 * in `lane-matrix.ts`; this file is only the CLI entry point + doc-file writer, kept separate so
 * `lane-matrix.ts` stays a pure, test-imported library with no fs-write / process.argv concerns.
 *
 * Run: `npm run lane-matrix --workspace packages/core` (see packages/core/package.json).
 * The generated file starts with an explicit "GENERATED — do not hand-edit" banner and the exact
 * regen command, so a reader who finds it stale knows precisely how to refresh it.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLaneMatrix, renderLaneMatrixMarkdown } from './lane-matrix.js';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    // The repo root is identified by having BOTH a top-level docs/ dir and a packages/ dir —
    // distinguishes it from the package root (packages/core/), which has neither.
    if (existsSync(join(dir, 'docs')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`render-lane-matrix: could not locate the repo root (docs/ + packages/) walking up from ${startDir}`);
}

export function renderDoc(): string {
  const matrix = buildLaneMatrix();
  const table = renderLaneMatrixMarkdown(matrix);
  return `# Lane × guard matrix

**GENERATED — do not hand-edit.** Regenerate with:

\`\`\`
npm run lane-matrix --workspace packages/core
\`\`\`

Derived directly from \`packages/core/src/beats/dispatch.ts\` and \`packages/core/src/conductor.ts\`
by \`packages/core/src/lane-matrix.ts\` (static analysis of each lane's own function span — see
that file's doc comment for the full rationale). A drift-detection test
(\`packages/core/test/lane-matrix.test.ts\`) pins the matrix below as a snapshot and fails CI the
moment a lane's real guard set changes — see [ADR-010](decisions/ADR-010-one-lane.md) point 6.

If this table disagrees with the code, the code is right and this file is stale: run the regen
command above, review the diff, and update the test's \`EXPECTED_SNAPSHOT\` deliberately (not by
blindly accepting whatever the regen produces) before committing both together.

${table}

## Reading the columns

- **Touches-overstep / spine check / judge / scout** — present (\`yes\`) iff the lane's own code
  calls that guard's real function (\`checkTouchesOverstep\`, \`checkSpine\`, \`runJudge\`,
  \`buildScoutPrompt\`). A comment merely naming the guard does not count — the generator strips
  comments before matching.
- **git push / alreadyShippedCommit / denialNote** — narrower markers for specific historical
  defect classes (ADR-010 context: WI-161's "no commit" park class, the push step, the
  reality-check fallback).
- **gate wrapper** — which gate-running helper the lane calls: \`runLaneGate\` (lane-aware
  dispatcher, picks the item's gate id), \`runGate\` (the plain shell-gate runner, called directly),
  a **local fork** (the conductor's own \`runClusterGate\`, a documented consolidation remainder —
  see conductor.ts's own top-of-file comment), or \`none\` (no code diff to gate — the planning
  lane only queues child items).
- **commit side** — \`dispatch\` (dispatch stages + commits the worker's in-scope output itself,
  via either the shared \`attemptScopedCommit\` helper or the batch lane's inline
  \`planScopedCommit\` + \`git commit\` sequence), \`worker\` (the spawned agent holds a
  commit-capable tool grant and commits itself), or \`n/a (no code diff)\` (planning lane).
`;
}

// Only write the file when this module is invoked directly (not when imported by a test).
const isMain = process.argv[1] && process.argv[1].endsWith('render-lane-matrix.js');
if (isMain) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(__dirname);
  const outPath = join(repoRoot, 'docs', 'lane-matrix.md');
  writeFileSync(outPath, renderDoc(), 'utf8');
  process.stderr.write(`[render-lane-matrix] wrote ${outPath}\n`);
}
