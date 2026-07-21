// Command layer — typed UI actions, the wiring table that maps
// them to domain commands, and the single dispatcher that owns network + receipts +
// refresh + retry. Components emit actions; only this layer names a command.

export * from './command-types.ts';
export * from './command-dispatcher.ts';
