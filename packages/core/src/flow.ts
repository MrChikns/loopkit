/**
 * flow.ts — Operational lifecycle and dependency-graph definitions.
 *
 * The ledger remains the authority. This module supplies the one typed lifecycle definition
 * used by the fold and the one pure dependency projection used by dispatch/read surfaces.
 */

export const ITEM_STATES = [
  'captured',
  'routed',
  'answered',
  'queued',
  'building',
  'gated',
  'parked',
  'approved',
  'merged',
  'accepted',
  'rejected',
  'done',
] as const;

export type ItemState = typeof ITEM_STATES[number];

export const ITEM_TERMINAL_STATES = [
  'merged',
  'rejected',
  'accepted',
  'answered',
  'done',
] as const satisfies readonly ItemState[];

export type ItemTransitionCause =
  | 'item.captured'
  | 'item.routed'
  | 'item.queued'
  | 'item.parked'
  | 'item.unparked'
  | 'item.approved'
  | 'item.rejected'
  | 'item.merged'
  | 'item.accepted'
  | 'item.reopened'
  | 'build.dispatched'
  | 'build.finished'
  | 'build.crashed'
  | 'build.stalled'
  | 'build.cancelled'
  | 'gate.passed'
  | 'gate.failed'
  | 'gate.parked';

export type ItemTransitionSource =
  | 'non-terminal'
  | 'terminal'
  | readonly ItemState[];

export interface ItemTransitionRule {
  readonly cause: ItemTransitionCause;
  readonly from: ItemTransitionSource;
  readonly to: ItemState;
}

/**
 * The lifecycle definition consumed by fold(). Broad non-terminal sources intentionally retain
 * legacy replay behavior: older ledgers sometimes omit intermediate events, so queue/merge/gate
 * receipts continue to fold without requiring a synthetic migration. Terminal exits remain
 * narrow: merged→accepted, or an explicit item.reopened from any terminal.
 */
export const ITEM_FLOW = {
  initialState: 'captured',
  states: ITEM_STATES,
  terminalStates: ITEM_TERMINAL_STATES,
  transitions: [
    { cause: 'item.captured', from: 'non-terminal', to: 'captured' },
    { cause: 'item.routed', from: ['captured'], to: 'routed' },
    { cause: 'item.routed', from: 'non-terminal', to: 'answered' },
    { cause: 'item.queued', from: 'non-terminal', to: 'queued' },
    { cause: 'item.parked', from: 'non-terminal', to: 'parked' },
    { cause: 'item.unparked', from: 'non-terminal', to: 'queued' },
    { cause: 'item.approved', from: 'non-terminal', to: 'approved' },
    { cause: 'item.rejected', from: 'non-terminal', to: 'rejected' },
    { cause: 'item.merged', from: 'non-terminal', to: 'merged' },
    { cause: 'item.accepted', from: 'non-terminal', to: 'accepted' },
    { cause: 'item.accepted', from: ['merged'], to: 'accepted' },
    { cause: 'item.reopened', from: 'terminal', to: 'queued' },
    { cause: 'build.dispatched', from: 'non-terminal', to: 'building' },
    { cause: 'build.finished', from: 'non-terminal', to: 'gated' },
    { cause: 'build.crashed', from: 'non-terminal', to: 'queued' },
    { cause: 'build.stalled', from: 'non-terminal', to: 'queued' },
    { cause: 'build.cancelled', from: ['building'], to: 'parked' },
    { cause: 'gate.passed', from: 'non-terminal', to: 'gated' },
    { cause: 'gate.failed', from: 'non-terminal', to: 'parked' },
    { cause: 'gate.parked', from: 'non-terminal', to: 'parked' },
  ] as const satisfies readonly ItemTransitionRule[],
} as const;

const TERMINAL_STATE_SET = new Set<ItemState>(ITEM_FLOW.terminalStates);

export function isTerminalItemState(state: ItemState): boolean {
  return TERMINAL_STATE_SET.has(state);
}

function sourceAllows(source: ItemTransitionSource, state: ItemState): boolean {
  if (source === 'terminal') return isTerminalItemState(state);
  if (source === 'non-terminal') return !isTerminalItemState(state);
  return source.includes(state);
}

/** True when the exported flow definition permits this exact state/cause transition. */
export function isAllowedItemTransition(
  from: ItemState,
  to: ItemState,
  cause: ItemTransitionCause,
): boolean {
  return ITEM_FLOW.transitions.some(rule =>
    rule.cause === cause && rule.to === to && sourceAllows(rule.from, from)
  );
}

/**
 * Structural validation for tests/tools. Keeping this pure makes definition drift visible
 * without teaching a second validator what the valid states or terminal states are.
 */
export function validateItemFlowDefinition(): string[] {
  const errors: string[] = [];
  const states = new Set<string>(ITEM_FLOW.states);
  if (!states.has(ITEM_FLOW.initialState)) errors.push(`unknown initial state: ${ITEM_FLOW.initialState}`);
  if (states.size !== ITEM_FLOW.states.length) errors.push('duplicate lifecycle state');
  for (const terminal of ITEM_FLOW.terminalStates) {
    if (!states.has(terminal)) errors.push(`unknown terminal state: ${terminal}`);
  }
  for (const rule of ITEM_FLOW.transitions) {
    if (!states.has(rule.to)) errors.push(`${rule.cause}: unknown destination ${rule.to}`);
    if (Array.isArray(rule.from)) {
      for (const from of rule.from) {
        if (!states.has(from)) errors.push(`${rule.cause}: unknown source ${from}`);
      }
    }
  }
  return errors;
}

export const DEFAULT_DEPENDENCY_CONDITION = 'merged-or-accepted' as const;
export type DependencyCompletionCondition = typeof DEFAULT_DEPENDENCY_CONDITION;
export type FoldedDependencyCondition = DependencyCompletionCondition | 'invalid';

export interface ItemDependency {
  item: string;
  condition: FoldedDependencyCondition;
  addedAt: string;
}

/** Minimal item shape needed by the pure graph projection (keeps flow.ts independent of fold.ts). */
export interface DependencyGraphItem {
  id: string;
  state: ItemState;
  dependencies?: readonly ItemDependency[];
}

export type DependencyStatus =
  | 'resolved'
  | 'unresolved'
  | 'missing'
  | 'cycle'
  | 'invalid-condition';

export interface DependencyEdgeReadiness {
  item: string;
  condition: FoldedDependencyCondition;
  status: DependencyStatus;
  state?: ItemState;
}

export interface ItemDependencyReadiness {
  item: string;
  ready: boolean;
  dependencies: DependencyEdgeReadiness[];
  unresolved: string[];
  missing: string[];
  cycles: string[][];
}

export interface DependencyGraphProjection {
  cycles: string[][];
  items: ItemDependencyReadiness[];
}

function activeEdges(items: readonly DependencyGraphItem[]): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const item of items) {
    edges.set(item.id, [...new Set((item.dependencies ?? []).map(dep => dep.item))].sort());
  }
  return edges;
}

/**
 * Deterministic strongly-connected components. Each returned component is a cycle; a self-edge
 * is represented as [WI-NNN]. Missing references are not vertices and are reported separately.
 */
function dependencyCycles(items: readonly DependencyGraphItem[]): string[][] {
  const ids = new Set(items.map(item => item.id));
  const edges = activeEdges(items);
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let index = 0;

  const visit = (id: string): void => {
    indexById.set(id, index);
    lowById.set(id, index);
    index++;
    stack.push(id);
    onStack.add(id);

    for (const next of edges.get(id) ?? []) {
      if (!ids.has(next)) continue;
      if (!indexById.has(next)) {
        visit(next);
        lowById.set(id, Math.min(lowById.get(id)!, lowById.get(next)!));
      } else if (onStack.has(next)) {
        lowById.set(id, Math.min(lowById.get(id)!, indexById.get(next)!));
      }
    }

    if (lowById.get(id) !== indexById.get(id)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort();
    if (component.length > 1 || (edges.get(id) ?? []).includes(id)) cycles.push(component);
  };

  for (const id of [...ids].sort()) {
    if (!indexById.has(id)) visit(id);
  }
  return cycles.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

/**
 * Pure dependency DAG/readiness projection. All active dependencies must resolve; missing
 * references, malformed conditions, and cycles fail closed.
 */
export function projectDependencyGraph(source: Iterable<DependencyGraphItem>): DependencyGraphProjection {
  const items = [...source].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(items.map(item => [item.id, item]));
  const cycles = dependencyCycles(items);
  const cyclesByItem = new Map<string, string[][]>();
  for (const cycle of cycles) {
    for (const id of cycle) {
      const list = cyclesByItem.get(id);
      if (list) list.push(cycle);
      else cyclesByItem.set(id, [cycle]);
    }
  }

  const readiness = items.map(item => {
    const ownCycles = cyclesByItem.get(item.id) ?? [];
    const dependencies = [...(item.dependencies ?? [])]
      .sort((a, b) => a.item.localeCompare(b.item))
      .map(dep => {
        const blocker = byId.get(dep.item);
        let status: DependencyStatus;
        if (ownCycles.some(cycle => cycle.includes(dep.item))) status = 'cycle';
        else if (!blocker) status = 'missing';
        else if (dep.condition !== DEFAULT_DEPENDENCY_CONDITION) status = 'invalid-condition';
        else if (blocker.state === 'merged' || blocker.state === 'accepted') status = 'resolved';
        else status = 'unresolved';
        return {
          item: dep.item,
          condition: dep.condition,
          status,
          ...(blocker ? { state: blocker.state } : {}),
        };
      });
    return {
      item: item.id,
      ready: ownCycles.length === 0 && dependencies.every(dep => dep.status === 'resolved'),
      dependencies,
      unresolved: dependencies
        .filter(dep => dep.status === 'unresolved' || dep.status === 'invalid-condition' || dep.status === 'cycle')
        .map(dep => dep.item),
      missing: dependencies.filter(dep => dep.status === 'missing').map(dep => dep.item),
      cycles: ownCycles,
    };
  });
  return { cycles, items: readiness };
}

/** The single readiness predicate used at dispatch boundaries. No row means fail closed. */
export function isItemDependencyReady(
  projection: DependencyGraphProjection,
  itemId: string,
): boolean {
  return projection.items.find(item => item.item === itemId)?.ready === true;
}

/**
 * Pre-append cycle check for the CLI. Adding item→dependency creates a cycle iff dependency can
 * already reach item (or the edge is a self-dependency).
 */
export function wouldCreateDependencyCycle(
  source: Iterable<DependencyGraphItem>,
  itemId: string,
  dependencyId: string,
): boolean {
  if (itemId === dependencyId) return true;
  const items = [...source];
  const edges = activeEdges(items);
  const seen = new Set<string>();
  const stack = [dependencyId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === itemId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of edges.get(id) ?? []) stack.push(next);
  }
  return false;
}
