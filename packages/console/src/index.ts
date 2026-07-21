/**
 * index.ts — @loopkit/console public library API.
 *
 *     import { startConsole } from '@loopkit/console';
 *     const handle = await startConsole({ ledgerDir: '.ai/ledger', port: 4100 });
 *     // handle.port, handle.close()
 */

export { startConsole } from './server.js';
export type { ConsoleOptions, ConsoleHandle } from './server.js';

export {
  renderCommand,
  renderMissions,
  renderItemTimeline,
  renderAcceptance,
  renderSystem,
  renderAnalytics,
  tierConfigFromLoopkitConfig,
} from './views.js';
export type { SegmentInfo } from './views.js';

export { esc } from './html.js';
export type { NavId } from './html.js';
