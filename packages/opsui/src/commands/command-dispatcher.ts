// The one command dispatcher — it owns the *only* path from a
// semantic UI action to a domain command: it resolves the action through the wiring
// table, guards destructive commands behind explicit confirmation, calls the injected
// transport with retry, maps every failure to a stable CommandError, and — separately
// from the receipt — announces `command accepted` and then `projection updated`,
// refreshing exactly the projections the command affects.
//
// Pure by construction: all side effects (network, announcements, refresh) are
// injected, so the wiring and lifecycle are unit-testable without a DOM or a server.

import type { ProjectionId } from '../projections/projection-types.ts';
import type {
  CommandError,
  CommandName,
  CommandReceipt,
  DomainCommand,
  UiAction,
} from './command-types.ts';

// --- The wiring table ----------------------------------------------------
// The single place a UI action becomes a domain command. `affects` lists the
// projections refreshed after acceptance; `destructive` gates confirmation.
type Wiring = { command: CommandName; affects: readonly ProjectionId[]; destructive: boolean };

const ACTION_WIRING: Record<UiAction['type'], Wiring> = {
  'intent.submit':     { command: 'CaptureIntent',   affects: ['work', 'company'],           destructive: false },
  'acceptance.accept': { command: 'AcceptSlice',      affects: ['acceptance', 'work'],         destructive: false },
  'acceptance.fail':   { command: 'FailSlice',        affects: ['acceptance', 'work'],         destructive: false },
  'decision.answer':   { command: 'AnswerDecision',   affects: ['decisions', 'work'],          destructive: false },
  'worker.question':   { command: 'AnswerWorker',     affects: ['work'],                       destructive: false },
  'watch.start':       { command: 'StartWatch',       affects: ['observability', 'health'],    destructive: false },
  'proposal.approve':  { command: 'ApproveProposal',  affects: ['planner', 'work'],            destructive: false },
  'thread.reply':      { command: 'ReplyThread',      affects: ['company'],                    destructive: false },
};

/** Resolve a UI action into its domain command. Returns `null` for an unknown action
 *  type — the dispatcher fails it loudly rather than sending an unmapped command. */
export function resolveCommand(action: UiAction): DomainCommand | null {
  const wiring = ACTION_WIRING[action.type];
  if (!wiring) return null;
  return {
    command: wiring.command,
    payload: action.payload,
    affects: wiring.affects,
    destructive: wiring.destructive,
  };
}

// --- Announcements (aria-live) ------------------------------------------
// `command accepted` and `projection updated` are announced as distinct phases so a
// screen reader never conflates the two.
export type DispatchAnnouncement =
  | { phase: 'pending'; command: CommandName }
  | { phase: 'accepted'; command: CommandName; receiptId: string }
  | { phase: 'updated'; projections: readonly ProjectionId[] }
  | { phase: 'failed'; command: CommandName; error: CommandError };

/** The outcome of a dispatch — a discriminated union so callers handle every case. */
export type DispatchOutcome =
  | { status: 'accepted'; receipt: CommandReceipt; affects: readonly ProjectionId[]; attempts: number }
  | { status: 'failed'; error: CommandError; attempts: number }
  | { status: 'needs-confirmation'; command: CommandName };

export type DispatchDeps = {
  /** Sends the command and resolves with a receipt, or throws (mapped to CommandError). */
  transport: (command: DomainCommand) => Promise<CommandReceipt>;
  /** Optional aria-live sink — receives each lifecycle phase. */
  announce?: (a: DispatchAnnouncement) => void;
  /** Optional projection refresher — called once with the affected ids after acceptance. */
  refresh?: (projections: readonly ProjectionId[]) => void;
  /** Max transport attempts for retriable failures (default 3). */
  maxAttempts?: number;
};

export type DispatchOptions = {
  /** Set once a destructive command has passed its confirmation component. */
  confirmed?: boolean;
};

/** Normalise any thrown transport value into a stable CommandError. A value already
 *  shaped like a CommandError is trusted; an HTTP-ish `status` is mapped; everything
 *  else is a network/unknown fault. */
export function toCommandError(thrown: unknown): CommandError {
  if (thrown && typeof thrown === 'object') {
    const e = thrown as Record<string, unknown>;
    if (typeof e['kind'] === 'string' && typeof e['retriable'] === 'boolean') {
      return {
        kind: e['kind'] as CommandError['kind'],
        message: typeof e['message'] === 'string' ? e['message'] : 'Command failed',
        retriable: e['retriable'] as boolean,
        ...(typeof e['status'] === 'number' ? { status: e['status'] as number } : {}),
      };
    }
    if (typeof e['status'] === 'number') return fromStatus(e['status'] as number);
  }
  const message = thrown instanceof Error ? thrown.message : 'Network error';
  return { kind: 'network', message, retriable: true };
}

function fromStatus(status: number): CommandError {
  if (status === 401 || status === 403) return { kind: 'permission', message: 'Permission denied', retriable: false, status };
  if (status === 409) return { kind: 'conflict', message: 'Conflicting command', retriable: false, status };
  if (status >= 400 && status < 500) return { kind: 'validation', message: 'Command rejected', retriable: false, status };
  if (status >= 500) return { kind: 'server', message: 'Server error', retriable: true, status };
  return { kind: 'unknown', message: `Unexpected status ${status}`, retriable: false, status };
}

/** Build the single dispatcher. All side effects are injected. */
export function createDispatcher(deps: DispatchDeps): {
  dispatch: (action: UiAction, opts?: DispatchOptions) => Promise<DispatchOutcome>;
} {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 3);
  const announce = deps.announce ?? (() => {});
  const refresh = deps.refresh ?? (() => {});

  async function dispatch(action: UiAction, opts: DispatchOptions = {}): Promise<DispatchOutcome> {
    const command = resolveCommand(action);
    if (!command) {
      const error: CommandError = { kind: 'validation', message: `Unknown action: ${action.type}`, retriable: false };
      return { status: 'failed', error, attempts: 0 };
    }

    // Destructive commands never fire without explicit confirmation.
    if (command.destructive && !opts.confirmed) {
      return { status: 'needs-confirmation', command: command.command };
    }

    announce({ phase: 'pending', command: command.command });

    let attempts = 0;
    let lastError: CommandError = { kind: 'unknown', message: 'Command failed', retriable: false };

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const receipt = await deps.transport(command);
        announce({ phase: 'accepted', command: command.command, receiptId: receipt.receiptId });
        // `projection updated` is a separate announcement from the receipt.
        refresh(command.affects);
        announce({ phase: 'updated', projections: command.affects });
        return { status: 'accepted', receipt, affects: command.affects, attempts };
      } catch (thrown) {
        lastError = toCommandError(thrown);
        if (!lastError.retriable || attempts >= maxAttempts) break;
      }
    }

    announce({ phase: 'failed', command: command.command, error: lastError });
    return { status: 'failed', error: lastError, attempts };
  }

  return { dispatch };
}
