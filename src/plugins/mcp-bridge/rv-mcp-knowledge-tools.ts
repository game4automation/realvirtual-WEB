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
 * ## Why not just `web_component_set(type='NodeKnowledge')`
 *
 * Because the persistence chain validates no names. `web_component_set` takes
 * `type` and `props` as free strings, so `NodeKnowlege` — one missing letter —
 * would be written into the GLB permanently and without a word of complaint.
 * Here the type and field names are constants from `rv-node-knowledge.ts` and
 * cannot be misspelled from outside.
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
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
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
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

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

  @McpTool('Store or replace the knowledge note on one scene node — durable agent memory that travels inside the GLB. Overwrites the entire note; it does not append. Write facts worth recalling in a LATER session (what an axis really does, measured limits, why a node is misnamed), not scratch or session state. Prefer short Markdown bullets under headings over prose. An empty or whitespace-only note deletes the entry. Set confidence honestly: "inferred" or "unverified" stops a guess from reading as a measurement later. Check persistedTo in the result — "none" means the workspace keeps nothing and the note is gone on reload.', { readOnly: false })
  async webKnowledgeSet(
    @McpParam('path', 'Full hierarchy path of the node (from web_node_find / web_node_tree).') path: string,
    @McpParam('markdown', `Note body as Markdown, max ${MAX_NOTE_CHARS} UTF-16 code units. Empty or whitespace-only deletes the note.`) markdown: string,
    @McpParam('author', '"agent" (default) or "user" — provenance only, not access control.', 'string', false) author?: string,
    @McpParam('confidence', '"observed" (default), "inferred" or "unverified" — how the knowledge was obtained.', 'string', false) confidence?: string,
  ): Promise<string> {
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

  @McpTool('Get the knowledge note stored on one scene node as raw Markdown, with its provenance header (updatedAt, author, confidence). Read this before re-deriving what a node does — an earlier session may already have worked it out. Distinguishes an unknown path from a node that simply carries no note. Note that confidence "inferred" or "unverified" marks a previous agent\'s guess, not a measurement, and updatedAt tells you how stale it may be.', { readOnly: true })
  async webKnowledgeGet(
    @McpParam('path', 'Full hierarchy path of the node (from web_node_find / web_knowledge_list).') path: string,
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
        hint: 'Use web_knowledge_list to see which nodes carry notes.',
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

  @McpTool('List every scene node carrying a knowledge note, newest first, with an excerpt and provenance. Pass query to full-text filter over note text and node path. Start a session here: it maps in one call what earlier sessions already established about this machine, so you can read the relevant notes with web_knowledge_get instead of re-deriving them.', { readOnly: true })
  async webKnowledgeList(
    @McpParam('query', 'Case-insensitive substring matched against note text and node path.', 'string', false) query?: string,
    @McpParam('limit', `Maximum rows returned (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}).`, 'number', false) limit?: number,
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
    persistence.persistenceNote = 'Stored in the asset document — call web_editor_save to write the GLB.';
  } else if (persistedTo === 'scene') {
    persistence.persistenceNote = 'Optimistic: flushed by the debounced scene autosave, which is cancelled (not flushed) by a model switch.';
  } else {
    persistence.persistenceNote = 'Nothing is persisted in this workspace (transient or no edit target) — the note is gone on reload.';
  }
  return persistence;
}
