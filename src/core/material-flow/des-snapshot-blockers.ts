// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subsystems that run in a DES run without a snapshot participant (LogicSteps, PLC programs, IK paths, playback,
 * replay) register a blocker; the DES runner of the SAME viewer refuses capture and restore while one reports a reason.
 *
 * One registry per viewer (`viewer.snapshotBlockers`), never module-global: a second viewer on the page must not be
 * refused because of the first one's PLC program (plan-2059 O7).
 */
/** One subsystem kind present in the model, with the nodes that carry it (`system` is the user-facing name). */
export interface DesLogicPresence {
  readonly system: string;
  readonly nodes: readonly string[];
}

export class DesSnapshotBlockers {
  private readonly blockers = new Map<symbol, { id: string; reason: () => string | null; presence?: () => readonly DesLogicPresence[] }>();

  /**
   * Register a blocker; returns the function that removes it again.
   *
   * `presence` (optional) answers a different question than `reason`: not "is it running right now" but "does the
   * model HAVE such a subsystem at all" — the DES experiment batch pauses the viewer, so logic that merely exists would
   * stand still during the batch (plan-2062 / plan-2207). {@link batchHazards} collects the answers.
   */
  register(id: string, reason: () => string | null, presence?: () => readonly DesLogicPresence[]): () => void {
    const token = Symbol(id);
    this.blockers.set(token, { id, reason, presence });
    return () => { this.blockers.delete(token); };
  }

  /** Subsystems that are present in the model and do not advance on the simulation clock; empty = a batch may run. */
  batchHazards(): DesLogicPresence[] {
    return [...this.blockers.values()].flatMap(({ presence }) => (presence?.() ?? []).filter(p => p.nodes.length > 0));
  }

  /** `id: reason` of every blocker that is active right now. */
  reasons(): string[] {
    return [...this.blockers.values()].flatMap(({ id, reason }) => {
      const value = reason();
      return value === null ? [] : [`${id}: ${value}`];
    });
  }
}

/** `LogicStep: A, B; IK path: C` — at most five nodes per system, the rest as a count. */
export function describeLogicPresence(hazards: readonly DesLogicPresence[]): string {
  return hazards.map(({ system, nodes }) => {
    const shown = nodes.slice(0, 5).join(', ');
    return `${system}: ${shown}${nodes.length > 5 ? ` (+${nodes.length - 5} more)` : ''}`;
  }).join('; ');
}
