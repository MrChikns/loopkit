// Action + command contract. Components emit semantic *UI actions*; a
// single dispatcher (see command-dispatcher.ts) translates them into *domain commands*
// sent to the ops backend, and returns a receipt. Components never call arbitrary
// endpoints and never name a command — the wiring lives in exactly one place here.
//
// This is the disposable projection/interaction layer: the command *names*
// below are the console's own vocabulary, not the durable event-ledger contract.

import type { ProjectionId } from '../projections/projection-types.ts';

// --- UI action payloads ---------------------------------------------------
// One payload per semantic action a component can raise. Kept minimal and typed;
// arbitrary strings are never accepted at the dispatcher boundary.

/** Founder drops intent from the composer. */
export type SubmitIntent = { text: string; thread?: string };
/** Accept a deployed slice awaiting founder eyes. */
export type AcceptSlice = { workItem: string; note?: string };
/** Reject a slice back into the queue with a reason. */
export type FailSlice = { workItem: string; reason: string };
/** Answer a parked decision (unpark → log the D-NNN). */
export type AnswerDecision = { decision: string; answer: string };
/** Reply to a worker agent's blocking question. */
export type QuestionWorker = { workItem: string; question: string };
/** Start watching a target (SLO / instance / loop). */
export type StartWatch = { target: string };
/** Approve a proposal (planner grooming candidate). */
export type ApproveProposal = { proposal: string };
/** Reply on a company/conversation thread. */
export type ReplyThread = { thread: string; text: string };

/** The closed set of semantic UI actions a component may emit. */
export type UiAction =
  | { type: 'intent.submit'; payload: SubmitIntent }
  | { type: 'acceptance.accept'; payload: AcceptSlice }
  | { type: 'acceptance.fail'; payload: FailSlice }
  | { type: 'decision.answer'; payload: AnswerDecision }
  | { type: 'worker.question'; payload: QuestionWorker }
  | { type: 'watch.start'; payload: StartWatch }
  | { type: 'proposal.approve'; payload: ApproveProposal }
  | { type: 'thread.reply'; payload: ReplyThread };

/** Every domain command the console can send. Internal console vocabulary. */
export type CommandName =
  | 'CaptureIntent'
  | 'AcceptSlice'
  | 'FailSlice'
  | 'AnswerDecision'
  | 'AnswerWorker'
  | 'StartWatch'
  | 'ApproveProposal'
  | 'ReplyThread';

/** A resolved domain command ready for the transport. Carries the
 *  projections it will invalidate so the dispatcher can refresh them on success. */
export type DomainCommand = {
  command: CommandName;
  payload: UiAction['payload'];
  /** Projections whose data this command may change — refreshed after acceptance. */
  affects: readonly ProjectionId[];
  /** Irreversible/destructive consequence — requires explicit confirmation. */
  destructive: boolean;
};

/** The receipt a command returns — `command accepted`, distinct from `projection
 *  updated`. Transports MUST return one on success. */
export type CommandReceipt = {
  receiptId: string;
  command: CommandName;
  acceptedAt: string;
};

/** Stable error shape — every transport failure is mapped to one of these so the UI
 *  never surfaces a raw exception. `retriable` drives the dispatcher's retry loop. */
export type CommandErrorKind =
  | 'network'
  | 'server'
  | 'validation'
  | 'permission'
  | 'conflict'
  | 'unknown';

export type CommandError = {
  kind: CommandErrorKind;
  message: string;
  retriable: boolean;
  status?: number;
};
