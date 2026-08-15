// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-describe-tool — `web_describe`, the state-aware orientation tool (plan-707 part a).
 *
 * The tool LIST tells an agent what exists. It says nothing about what is true
 * right now: which workspace is active, whether a document is open and what is
 * in it, what is selected, what is running. Until this tool existed an agent
 * had to assemble that from three or four separate calls — and the three
 * documented dead ends (a kinematize batch stuck at `busy`, a library open that
 * silently produced an EMPTY document, a group assignment that changed nothing)
 * were all invisible in every one of them.
 *
 * `web_describe` answers three questions in ONE read-only call:
 *   - where am I           → {@link DescribeResult.mode} / `document` / `selection` / `runtime`
 *   - what is NOT possible → {@link DescribeResult.blocked}, each with the tool that unblocks it
 *   - what next            → {@link DescribeResult.next}, from the declarative {@link NEXT_RULES}
 *
 * Three deliberate properties:
 *
 *  1. It AGGREGATES, it does not recompute. Every number comes from the same
 *     getter `web_status` / `web_editor_status` / `web_selection_get` read, so
 *     the two tools cannot drift into disagreeing about the same machine.
 *  2. `next` is a RULE TABLE, first match wins — not a generated sentence. A
 *     recommendation that varies between calls is worse than none.
 *  3. It COMPLEMENTS `web_help`, it does not replace it: `guide` points AT a
 *     topic by tool name and copies no guide content. `web_help` stays the
 *     static workflow reference; this tool is the dynamic half.
 *
 * It carries no `web_editor_` prefix on purpose, so the bridge's editor
 * choreography (rv-mcp-editor-feedback.ts) skips it and a describe call moves
 * neither selection, panels nor camera — the property `web_node_bounds` cannot
 * claim, and the reason this tool is `readOnly: true`.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { requireEditor, isGuardError } from './rv-mcp-editor-guard';

/** The open asset document, as much of it as an agent needs to act. */
export interface DescribeDocument {
  name: string;
  /** 'empty' | 'document' | … — a document with nodeCount <= 1 is the A2 dead end. */
  baseKind: string;
  dirty: boolean;
  /** A call is still running (or hung) — do not push another one after it. */
  busy: boolean;
  opCount: number;
  nodeCount: number;
  canUndo: boolean;
}

/** One blocked tool family plus the exact tool that unblocks it. */
export interface DescribeBlocked {
  family: string;
  reason: string;
}

export interface DescribeResult {
  /** Active workspace, null before the first mode switch. */
  mode: string | null;
  availableModes: string[];
  /** The open asset document — null when the asset editor is not active. */
  document: DescribeDocument | null;
  selection: { count: number; firstPath: string | null };
  runtime: {
    connectionState: string;
    simRunning: boolean;
    modelUrl: string | null;
    driveCount: number;
    signalCount: number;
  };
  /** What is gated right now and why (F3). */
  blocked: DescribeBlocked[];
  /** The ONE recommended next action, naming a concrete tool (F2). */
  next: string;
  /** Pointer at the matching static guide — complements, never duplicates (F5). */
  guide: string | null;
}

/**
 * State the rules see. Flat on purpose: a rule is a boolean expression over
 * facts, and a rule that has to dig through nested objects invites the kind of
 * `undefined` that turns a recommendation into a crash.
 */
interface DescribeFacts {
  mode: string | null;
  hasModel: boolean;
  doc: DescribeDocument | null;
  selectionCount: number;
}

interface NextRule {
  when: (f: DescribeFacts) => boolean;
  next: string;
  guide?: string;
}

/**
 * The `next` table — evaluated top to bottom, FIRST match wins.
 *
 * Order is the whole design: the three rules that encode a known dead end
 * (`busy`, empty library open, nothing perceived yet) sit above the ordinary
 * workflow rules, because an agent in one of those states is exactly the agent
 * that will otherwise keep pushing calls into a machine that is not listening.
 */
export const NEXT_RULES: readonly NextRule[] = [
  {
    // A1 — a kinematize batch that took React down leaves the tool at busy.
    when: (f) => f.doc?.busy === true,
    next: 'A call is still running or hung — poll web_editor_status until busy is false; '
      + 'do NOT push another web_editor_* call after it',
    guide: 'web_help("editor")',
  },
  {
    // A2 — `web_editor_open(source=library)` that produced nothing, silently.
    // The kind is `document` since plan-716 §2.6; `baseKind` is a stringified
    // field, so a stale literal here fails silently rather than at compile time.
    when: (f) => f.doc !== null && f.doc.baseKind === 'document' && f.doc.nodeCount <= 1,
    next: 'Document is EMPTY although it was opened from the library — re-import the asset with '
      + 'web_editor_import_glb from the project\'s imports/ folder',
    guide: 'web_help("editor")',
  },
  {
    when: (f) => f.doc !== null && f.doc.opCount === 0,
    next: 'Perceive before acting — web_node_tree, then web_camera_focus / web_node_bounds',
    guide: 'web_help("editor")',
  },
  {
    when: (f) => f.doc !== null && f.doc.dirty,
    next: 'Verify the authored motion with web_editor_verify_drive before web_editor_save',
    guide: 'web_help("editor")',
  },
  {
    when: (f) => f.doc !== null,
    next: 'Continue authoring with the web_editor_* tools; finish with web_editor_save',
    guide: 'web_help("editor")',
  },
  {
    when: (f) => !f.hasModel && f.mode === 'planner',
    next: 'Pick a part with web_library_list, then place it with web_layout_place',
    guide: 'web_help("layout")',
  },
  {
    when: (f) => !f.hasModel,
    next: 'Nothing is loaded — open a scene with web_scene_open, or start authoring with '
      + 'web_editor_open(source=empty)',
  },
  {
    when: (f) => f.mode === 'planner',
    next: 'Extend the layout: web_layout_list, then web_layout_snap_attach to chain parts',
    guide: 'web_help("layout")',
  },
  {
    when: (f) => f.mode === 'des',
    next: 'Inspect the event simulation with web_des_status, then web_des_bottleneck',
    guide: 'web_help("des")',
  },
  {
    when: () => true,
    next: 'Orient in the running model: web_drive_list, then web_signal_status',
    guide: 'web_help("simulation")',
  },
];

/** Pick the first matching rule. The table ends in an unconditional rule, so this never fails. */
export function chooseNext(facts: DescribeFacts): { next: string; guide: string | null } {
  for (const rule of NEXT_RULES) {
    if (rule.when(facts)) return { next: rule.next, guide: rule.guide ?? null };
  }
  // Unreachable while the table keeps its catch-all, but a silent `undefined`
  // in a field an agent reads as instruction is not an acceptable failure mode.
  return { next: 'Call web_status to orient', guide: null };
}

/**
 * Which tool families are gated right now, and by what.
 *
 * Derived from the SAME facts as `next` — the two must never disagree about
 * whether the editor is open.
 */
export function computeBlocked(facts: DescribeFacts): DescribeBlocked[] {
  const out: DescribeBlocked[] = [];
  if (facts.mode !== 'planner') {
    out.push({
      family: 'web_layout_*',
      reason: 'Needs planner mode — call web_mode_set("planner")',
    });
  }
  if (facts.doc === null) {
    out.push({
      family: 'web_editor_*',
      reason: 'No asset document is open — call web_editor_open(source=empty|library)',
    });
  }
  if (facts.mode !== 'des') {
    out.push({
      family: 'web_des_*',
      reason: 'Needs the DES workspace — call web_mode_set("des") (internal builds only)',
    });
  }
  return out;
}

export class McpDescribeTool {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  @McpTool(
    'Report where you are and what to do next in one read-only call: active and available modes, '
    + 'the open asset document (name, base kind, dirty, busy, op/node counts, undo), selection '
    + 'size, runtime (connection, simulation running, model URL, drive and signal counts). Two '
    + 'derived fields make it actionable: `blocked` names each gated tool family with the tool '
    + 'that unblocks it, and `next` names the ONE recommended action for this exact state — a busy '
    + 'editor, a library document that opened empty, an unverified drive before save. Call it '
    + 'first in a session and whenever a result surprises you. Changes nothing: not selection, '
    + 'panels or camera. Deep guides stay in web_help.',
    { readOnly: true },
  )
  async webDescribe(
    @McpParam('focus', 'Reserved for a narrower report; ignored today.', 'string', false)
    _focus: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });

    // Every read is optional. This is the tool an agent reaches for when
    // something is already wrong, so a half-built viewer must yield a partial
    // answer, never an exception — an orientation tool that throws leaves the
    // caller exactly where it was stuck.
    const doc = this._document(v);
    const selectedPaths = v.selectionManager?.getSnapshot().selectedPaths ?? [];
    const facts: DescribeFacts = {
      mode: v.modes?.activeMode ?? null,
      hasModel: !!v.currentModelUrl || !!v.currentModelRoot,
      doc,
      selectionCount: selectedPaths.length,
    };
    const { next, guide } = chooseNext(facts);

    const result: DescribeResult = {
      mode: facts.mode,
      availableModes: v.modes?.list().map((m) => m.id) ?? [],
      document: doc,
      selection: {
        count: selectedPaths.length,
        firstPath: selectedPaths[0] ?? null,
      },
      runtime: {
        connectionState: v.connectionState,
        simRunning: !v.isSimulationPaused,
        modelUrl: v.currentModelUrl,
        // The same two getters web_status reads — never a second count (R8).
        driveCount: v.drives?.length ?? 0,
        signalCount: v.signalStore?.size ?? 0,
      },
      blocked: computeBlocked(facts),
      next,
      guide,
    };
    return JSON.stringify(result);
  }

  /**
   * The open document, or null.
   *
   * `nodeCount` is the one number that has to be walked, and it is walked
   * exactly the way `web_editor_status` walks it — the A2 dead end is precisely
   * a document whose `base.kind` promises content that the tree does not have.
   */
  private _document(v: RVViewer): DescribeDocument | null {
    if (!v.modes) return null;
    const ctx = requireEditor(v);
    if (isGuardError(ctx)) return null;
    const snap = ctx.doc.getSnapshot();
    let nodeCount = 0;
    v.currentModelRoot?.traverse(() => { nodeCount++; });
    return {
      name: snap.name,
      baseKind: String((snap.base as { kind?: unknown } | null)?.kind ?? 'unknown'),
      dirty: snap.dirty,
      busy: snap.busy,
      opCount: snap.opCount,
      nodeCount,
      canUndo: snap.canUndo,
    };
  }
}
