// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-knowledge-tools — an agent's memory of a machine (plan-394).
 *
 * Delegate class of McpBridgePlugin (multi-instance dispatcher — see
 * rv-mcp-tools.ts).
 *
 * ## Three tools, not six
 *
 * `set` / `get` / `list`, with search folded into `list(query)`. Tool metadata is
 * charged to the context window of EVERY bridge session, and this bridge already
 * announces well over a hundred tools — a fourth "search" tool would have bought
 * nothing that a parameter does not.
 *
 * ## Knowledge-specific authoring
 *
 * `web_execute("component.setFields", …)` validates component fields. These tools
 * additionally enforce the knowledge limits and report the persistence target.
 * Type and field names are constants from `rv-node-knowledge.ts`.
 *
 * ## Two refusals these tools make on purpose
 *
 * **They do not report a durable write they did not make.** `EditTarget.available`
 * is `true` in a transient workspace too, where every op is accepted, undoable
 * and discarded on reload. So `persistedTo` comes from
 * `getActivePersistenceTarget()` — two signals, not one — and reports `'none'`
 * for that case rather than the comfortable `'scene'`. (`rv-mcp-signal-bind-tools`
 * is this file's structural template but NOT its template for this check: it
 * still derives its persistence claim from `available` alone.)
 *
 * **They do not truncate a note on the way in.** Over the limit is an error, not
 * a silent shortening: half a sentence of engineering knowledge that reads as
 * whole is worse than no note. Reading and listing DO truncate — but they say so
 * with a `truncated` flag.
 *
 * ## The write gate
 *
 * `set` is declared `readOnly: false`, which is all this file does about
 * authorisation: CONNECT refuses to dispatch any `web_*` tool not announced
 * read-only while its write switch is off.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { valueOrThrowToolJson } from '../../core/hmi/rv-command-context';
import {
  commandRegistry,
  type CommandDescriptor,
  type CommandImpl,
  type CommandRegistry,
} from '../../core/hmi/rv-command-registry';

import {
  getActiveEditTarget,
  getActivePersistenceTarget,
  type PersistenceTarget,
} from '../../core/hmi/rv-edit-target';
import { getNodeId } from '../../core/engine/rv-node-id';
import {
  MAX_NOTE_CHARS,
  NODE_KNOWLEDGE_FIELDS,
  NODE_KNOWLEDGE_TYPE,
  asAuthor,
  asConfidence,
  isEmptyNote,
  readNodeKnowledge,
  type NodeKnowledgeExtras,
} from '../../core/engine/rv-node-knowledge';
import type { RvExtrasEditorPlugin } from '../../core/hmi/rv-extras-editor';

/** Command id of the knowledge-note write (alias tool `web_knowledge_set`, plan-641 Nachtrag). */
export const KNOWLEDGE_SET_COMMAND = 'knowledge.set';

/** Characters of note text echoed per row by `web_knowledge_list`. */
const LIST_EXCERPT_CHARS = 160;

/** Default and hard ceiling for `web_knowledge_list` rows — mirrors `web_node_find`. */
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

function err(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ error: message, ...extra });
}

/** One row of `web_knowledge_list`. */
interface KnowledgeRow {
  path: string;
  chars: number;
  updatedAt: string;
  author: string;
  confidence: string;
  excerpt: string;
  truncated?: true;
}

export class McpKnowledgeTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {
    // plan-641 Nachtrag: the bound `web_knowledge_set` needs its command before discover.
    ensureKnowledgeCommandsRegistered();
  }

  private get viewer(): RVViewer | undefined { return this.getViewer(); }

  /** The plugin owning the guarded rv_extras write path. */
  private get editor(): RvExtrasEditorPlugin | undefined {
    return this.viewer?.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor') ?? undefined;
  }

  /**
   * Resolve a path to its node AND canonical path, or explain the failure.
   *
   * The existence check is the whole of F10's first half: without it a note for
   * a mistyped path is accepted by the op log, written into `userData` of
   * nothing, and reported as a success.
   */
  private _resolve(path: string): { node: Object3D; path: string } | string {
    const reg = this.viewer?.registry;
    if (!reg) return err('No registry available');
    const trimmed = (path ?? '').trim();
    if (!trimmed) return err('path is required');
    const node = reg.getNode(trimmed);
    if (!node) {
      return err(`Node not found: "${trimmed}"`, {
        hint: 'Use web_node_find or web_node_tree for valid node paths.',
      });
    }
    return { node, path: reg.getPathForNode(node) ?? trimmed };
  }


  /** The note write itself — the body of the `knowledge.set` command. JSON, `{error}` on refusal. */
  async setNote(path: string, markdown: string, author?: string, confidence?: string): Promise<string> {
    const resolved = this._resolve(path);
    if (typeof resolved === 'string') return resolved;
    const editor = this.editor;
    if (!editor) return err('Extras editor not available');

    const text = String(markdown ?? '');
    // Length first, and as a hard failure. Counted in UTF-16 code units
    // (String.length) — the documented convention: 2001 astral emoji are 4002
    // units and are rejected, which is intended, not a bug.
    if (text.length > MAX_NOTE_CHARS) {
      return err(
        `Note is ${text.length} characters, over the ${MAX_NOTE_CHARS} limit — nothing was stored`,
        {
          chars: text.length,
          limit: MAX_NOTE_CHARS,
          hint: 'Shorten the note to the durable facts. It is not truncated for you on purpose.',
        },
      );
    }

    const persistedTo = getActivePersistenceTarget();

    if (isEmptyNote(text)) {
      return this._clear(resolved.node, resolved.path, persistedTo);
    }

    const entry: NodeKnowledgeExtras = {
      Note: text,
      UpdatedAt: new Date().toISOString(),
      Author: asAuthor(author),
      Confidence: asConfidence(confidence),
      NodeIdAtWrite: getNodeId(resolved.node) ?? '',
    };

    // Every field goes through the guarded write path, and EVERY return value is
    // checked: `updateOverlayField` returns false for a readonly field, for a
    // locked LayoutObject ancestor and for an ephemeral field. A rejected write
    // that reported success is exactly the failure F10 exists to prevent.
    const rejected: string[] = [];
    for (const field of NODE_KNOWLEDGE_FIELDS) {
      if (!editor.updateOverlayField(resolved.path, NODE_KNOWLEDGE_TYPE, field, entry[field])) {
        rejected.push(field);
      }
    }
    if (rejected.length > 0) {
      return err(
        `The write was refused for ${rejected.join(', ')} — the note was not stored`,
        {
          path: resolved.path,
          rejected,
          hint: 'A locked LayoutObject ancestor is the usual cause; unlock it and retry.',
          persistedTo: 'none',
        },
      );
    }

    mirrorIntoUserData(resolved.node, entry);

    // Confirm from the state, not from the intent — the same discipline the
    // signal-bind tools apply. `updateOverlayField` returning true means "no
    // guard refused it", which is a weaker claim than "the note is there".
    const stored = readNodeKnowledge(resolved.node);
    if (!stored || stored.Note !== text) {
      return err('The note did not land on the node — nothing was stored', {
        path: resolved.path, persistedTo: 'none',
      });
    }

    return JSON.stringify({
      path: resolved.path,
      chars: text.length,
      updatedAt: entry.UpdatedAt,
      author: entry.Author,
      confidence: entry.Confidence,
      ...persistenceReport(persistedTo),
    });
  }

  /**
   * Delete the entry outright — no field stub left behind (F7).
   *
   * Two different mechanisms, because the two documents differ: the AssetDocument
   * has a real `removeComponent` op, the SceneStore has none. There, one
   * `unsetField` per field inside a transaction is the equivalent, and the order
   * matters for a reason worth stating: `deleteUserDataField` drops the type hull
   * only once the LAST field is gone, so unsetting `Note` alone would leave a
   * `NodeKnowledge: { UpdatedAt, Author, … }` husk in the GLB forever.
   */
  private async _clear(
    node: Object3D,
    path: string,
    persistedTo: PersistenceTarget,
  ): Promise<string> {
    const existing = readNodeKnowledge(node);
    if (!existing) {
      return JSON.stringify({
        path, chars: 0, removed: false,
        note: 'Node had no knowledge note — nothing to remove.',
        ...persistenceReport(persistedTo),
      });
    }

    const target = getActiveEditTarget();
    if (!target.available) {
      return err('No active edit target, so the note cannot be removed', {
        path, persistedTo: 'none',
      });
    }

    if (target.removeComponent) {
      target.removeComponent(path, NODE_KNOWLEDGE_TYPE);
    } else {
      // Read the fields actually present rather than the canonical list: a note
      // written by an older build (or hand-edited) may carry fewer.
      const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      const present = Object.keys(rv?.[NODE_KNOWLEDGE_TYPE] ?? {});
      await target.withTransaction(`Remove ${NODE_KNOWLEDGE_TYPE}`, async () => {
        for (const field of present) {
          target.unsetField(path, NODE_KNOWLEDGE_TYPE, field, rv?.[NODE_KNOWLEDGE_TYPE]?.[field]);
        }
      });
    }

    // Same reasoning as `mirrorIntoUserData` on the write side: both the
    // `removeComponent` op and the `unsetField` transaction run through the
    // target's queue, so the live node still carries the entry when this returns.
    // Dropping it here makes `removed: true` true at the moment it is claimed.
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv) delete rv[NODE_KNOWLEDGE_TYPE];

    return JSON.stringify({
      path, chars: 0, removed: true,
      ...persistenceReport(persistedTo),
    });
  }

  /** Read-only command body; preserves the original JSON value contract. */
  async queryKnowledgeGet(
    path: string,
  ): Promise<string> {
    const resolved = this._resolve(path);
    if (typeof resolved === 'string') return resolved;

    // Raw userData, NOT the component registry: NodeKnowledge registers no
    // factory, so there is no instance to read — and a note set earlier in THIS
    // session lives in userData long before any reload.
    const entry = readNodeKnowledge(resolved.node);
    if (!entry || isEmptyNote(entry.Note)) {
      // Deliberately a different message from "Node not found" (F11): "you
      // mistyped the path" and "nobody has written this down yet" lead an agent
      // to opposite next actions.
      return err(`Node "${resolved.path}" has no knowledge note`, {
        path: resolved.path,
        hasNote: false,
        hint: 'Use web_query("knowledge.list", {}) to see which nodes carry notes.',
      });
    }

    const nodeIdNow = getNodeId(resolved.node) ?? '';
    return JSON.stringify({
      path: resolved.path,
      // Raw Markdown, not a re-encoded or JSON-wrapped rendering of it.
      markdown: entry.Note,
      chars: entry.Note.length,
      updatedAt: entry.UpdatedAt,
      author: entry.Author,
      confidence: entry.Confidence,
      // A weak self-check with a documented blind spot: NodeIds are unique
      // within a file, so two placements of one asset share theirs and no
      // mismatch is reported. Absence of a mismatch is NOT proof of identity.
      ...(entry.NodeIdAtWrite && nodeIdNow && entry.NodeIdAtWrite !== nodeIdNow
        ? { nodeIdMismatch: true, nodeIdAtWrite: entry.NodeIdAtWrite, nodeIdNow }
        : {}),
    });
  }

  /** Read-only command body; preserves the original JSON value contract. */
  async queryKnowledgeList(
    query?: string,
    limit?: number,
  ): Promise<string> {
    const viewer = this.viewer;
    const reg = viewer?.registry;
    const root = viewer?.currentModelRoot;
    if (!viewer || !reg) return err('No registry available');
    if (!root) return JSON.stringify({ total: 0, results: [] });

    const q = (query ?? '').trim().toLowerCase();
    const rows: KnowledgeRow[] = [];
    // One plain traversal per call, reading userData only — no bounds, no
    // matrices, no cache. `web_knowledge_list` is MCP-triggered, never ticked.
    root.traverse((node) => {
      const entry = readNodeKnowledge(node);
      if (!entry || isEmptyNote(entry.Note)) return;
      const nodePath = reg.getPathForNode(node);
      if (!nodePath) return;
      if (q && !`${entry.Note} ${nodePath}`.toLowerCase().includes(q)) return;
      const excerpt = entry.Note.slice(0, LIST_EXCERPT_CHARS);
      rows.push({
        path: nodePath,
        chars: entry.Note.length,
        updatedAt: entry.UpdatedAt,
        author: entry.Author,
        confidence: entry.Confidence,
        excerpt,
        ...(excerpt.length < entry.Note.length ? { truncated: true as const } : {}),
      });
    });

    // Newest first: a stale note and a fresh one on the same machine are not
    // equally interesting, and `updatedAt` is the only staleness signal there is.
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

    const cap = Math.max(1, Math.min(LIST_MAX_LIMIT, Math.round(limit ?? LIST_DEFAULT_LIMIT)));
    return JSON.stringify({
      total: rows.length,
      ...(rows.length > cap ? { truncated: true } : {}),
      results: rows.slice(0, cap),
    });
  }
}

/**
 * Reflect the just-written entry into `userData.realvirtual` synchronously.
 *
 * Needed because of a specific gap in the write path, not as belt-and-braces.
 * `updateOverlayField`'s optimistic mirror is `applyFieldToScene`, which begins
 * `if (!rv?.[componentType]) return` — it can UPDATE an existing component but
 * never CREATES one. The very first note on a node is exactly that case, so
 * without this the entry appears only once the edit target's op queue flushes
 * (`void store.applyOp(...)` is fire-and-forget), and `web_knowledge_get` called
 * straight afterwards would answer "no note" about a note that was just accepted.
 *
 * Writing the same values the ops already carry, so nothing diverges: the
 * executor's `writeUserDataField` later writes them again, idempotently, and an
 * undo removes them field by field as it would have anyway. Clone-on-write
 * matches `writeUserDataField` so reference-memoised inspector rows re-render.
 */
function mirrorIntoUserData(node: Object3D, entry: NodeKnowledgeExtras): void {
  const ud = node.userData as Record<string, unknown>;
  let rv = ud.realvirtual as Record<string, unknown> | undefined;
  if (!rv || typeof rv !== 'object') { rv = {}; ud.realvirtual = rv; }
  rv[NODE_KNOWLEDGE_TYPE] = { ...entry };
}

/**
 * The `persistedTo` half of every result, with the caveat spelled out.
 *
 * `'scene'` is optimistic and says so: the draft autosave is debounced, and a
 * workspace teardown CANCELS the pending timer instead of flushing it, so a note
 * written moments before a model switch is lost despite this answer.
 */
function persistenceReport(persistedTo: PersistenceTarget): Record<string, unknown> {
  const persistence: Record<string, unknown> = { persistedTo };
  if (persistedTo === 'asset') {
    persistence.persistenceNote = 'Stored in the document open in the editor — call web_editor_save to write the GLB.';
  } else if (persistedTo === 'scene') {
    persistence.persistenceNote = 'Optimistic: flushed by the debounced scene autosave, which is cancelled (not flushed) by a model switch.';
  } else {
    persistence.persistenceNote = 'Nothing is persisted in this workspace (transient or no edit target) — the note is gone on reload.';
  }
  return persistence;
}

// ─── plan-641 Nachtrag 2026-10-21: the `knowledge.set` command ──────────

interface KnowledgeSetArgs {
  readonly path: string;
  readonly markdown: string;
  readonly author?: string | null;
  readonly confidence?: string | null;
}

const knowledgeSet: CommandImpl<KnowledgeSetArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => (String(a?.path ?? '').trim() ? true : { reason: 'path is required' }),
  run: async (ctx, a) => valueOrThrowToolJson(
    await new McpKnowledgeTools(() => ctx.viewer).setNote(a.path, a.markdown, a.author ?? undefined, a.confidence ?? undefined),
  ),
  // M4: explicit values — no selection fallback, the defaults spelled out.
  resolveArgs: (_ctx, a) => ({
    path: String(a?.path ?? '').trim(),
    markdown: String(a?.markdown ?? ''),
    author: asAuthor(a?.author ?? undefined),
    confidence: asConfidence(a?.confidence ?? undefined),
  }),
};

/** Build the knowledge command (testable seam: no registry side effect). */
export function createKnowledgeCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  const set: CommandDescriptor<KnowledgeSetArgs, Record<string, unknown>> = {
    id: KNOWLEDGE_SET_COMMAND,
    label: 'Set knowledge note',
    undoLabel: 'Set knowledge note',
    readOnly: false,
    macro: true,
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    mcp: {
      tool: 'web_knowledge_set',
      params: [
        { name: 'path', type: 'string', required: true },
        { name: 'markdown', type: 'string', required: true },
        { name: 'author', type: 'string', required: false },
        { name: 'confidence', type: 'string', required: false },
      ],
    },
    argsSchema: { path: 'string', markdown: 'string', author: 'string', confidence: 'string' },
    eagerImpl: knowledgeSet,
    impl: () => Promise.resolve(knowledgeSet),
  };
  return [
    set,
    {
      id: 'knowledge.get', label: 'knowledge.get', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { path: 'string' },
      impl: async () => {
        const impl: CommandImpl<{ path?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpKnowledgeTools(() => ctx.viewer).queryKnowledgeGet(a?.path!)),
        };
        return impl;
      },
    },
    {
      id: 'knowledge.list', label: 'knowledge.list', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { query: 'string', limit: 'number' },
      impl: async () => {
        const impl: CommandImpl<{ query?: string; limit?: number }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpKnowledgeTools(() => ctx.viewer).queryKnowledgeList(a?.query, a?.limit)),
        };
        return impl;
      },
    },
  ] as unknown as CommandDescriptor<never, unknown>[];
}

const registeredKnowledge = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the knowledge command. */
export function ensureKnowledgeCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registeredKnowledge.has(registry)) return;
  registeredKnowledge.add(registry);
  for (const d of createKnowledgeCommandDescriptors()) registry.register(d);
}
