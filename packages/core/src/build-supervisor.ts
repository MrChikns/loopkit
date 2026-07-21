#!/usr/bin/env node
/**
 * build-supervisor.ts — standalone entry for the per-build survivability supervisor
 * (ADR-008 Phase B prep 1). A beat spawns THIS as a detached process so the exit file lands even
 * if the beat itself dies mid-build. Deliberately a THIN entry: all logic lives in supervisor.ts
 * so that module can be imported by tests without executing. See supervisor.ts for the full design.
 */
import { runSupervisorMain } from './supervisor.js';

runSupervisorMain(process.argv.slice(2)).catch(e => {
  process.stderr.write(`[supervisor] fatal: ${e}\n`);
  process.exit(1);
});
