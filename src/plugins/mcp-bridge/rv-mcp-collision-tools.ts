// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * MCP tools for the viewer's collision detection (plan-394 RVCollisionManager).
 *
 * Until now a collision was only visible to a human: an outline in the viewport
 * and a card in the messages panel. An agent tuning robot poses had no way to
 * ask "did anything touch?" — these tools close that gap:
 *
 * - `web_collision_watch` gives node subtrees a collision role for THIS session
 *   only (runtime registration, nothing is written into the document). That is
 *   the development check for a demo model that must ship without
 *   `CollisionRole` components — and therefore without collision messages.
 * - `web_collision_status` lists the participating bodies and the latched pairs.
 * - `web_collision_reset` clears the latched pairs and, on request, removes the
 *   session roles again.
 */
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { COLLISION_ROLES, toCollisionRole } from '../../core/engine/rv-collision-role';

interface WatchEntry { path: string; role: string }

export class McpCollisionTools {
  /** Nodes this tool registered — removed again by reset(clearWatch). */
  private readonly watched = new Map<Object3D, string>();

  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  @McpTool(
    'Give node subtrees a collision role for THIS SESSION ONLY (nothing is written into the document): '
    + 'bodies of different roles are checked against each other while the simulation runs. '
    + `Roles: ${COLLISION_ROLES.filter((r) => r !== 'None').join(', ')}. A body is never checked against a body nested inside it, `
    + 'so give the environment subtrees that do NOT contain the moving machine (e.g. the stations, not the model root). '
    + 'Read the result with web_collision_status; remove the roles with web_collision_reset(clearWatch=true).',
    { readOnly: false },
  )
  async webCollisionWatch(
    @McpParam('assignmentsJson', 'JSON array [{"path": "<node path>", "role": "Robot"}, ...]') assignmentsJson: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    let entries: WatchEntry[];
    try {
      entries = JSON.parse(assignmentsJson) as WatchEntry[];
      if (!Array.isArray(entries)) throw new Error('not an array');
    } catch (e) {
      return JSON.stringify({ error: `assignmentsJson must be a JSON array: ${String(e)}` });
    }
    const registered: { path: string; role: string }[] = [];
    const missing: string[] = [];
    const invalid: string[] = [];
    for (const { path, role } of entries) {
      const r = toCollisionRole(role);
      if (r === 'None') { invalid.push(`${path} (${role})`); continue; }
      const node = v.registry?.getNode(path) ?? null;
      if (!node) { missing.push(path); continue; }
      v.collisionManager.register(node, r);
      this.watched.set(node, r);
      registered.push({ path, role: r });
    }
    v.collisionManager.invalidate();
    return JSON.stringify({
      registered, missing, invalid,
      note: 'Bodies are rebuilt on the next simulation tick; check web_collision_status while the simulation runs.',
    });
  }

  @McpTool(
    'Collision state: the participating bodies (path, role, mesh count, aabbOnly = no triangle test possible) '
    + 'and the LATCHED colliding pairs (aPath/aRole, bPath/bRole, since). Pairs stay until web_collision_reset, '
    + 'so a contact during a whole cycle is reported even after the parts separated.',
    { readOnly: true },
  )
  async webCollisionStatus(
    @McpParam('includeBodies', 'Also list every body (default false: counts per role only)', 'boolean') includeBodies?: boolean,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const m = v.collisionManager;
    const byRole: Record<string, number> = {};
    for (const b of m.bodies) byRole[b.role] = (byRole[b.role] ?? 0) + 1;
    const pairs = m.activePairs.map((p) => ({
      a: p.aPath, aRole: p.aRole, b: p.bPath, bRole: p.bRole, since: p.since,
    }));
    return JSON.stringify({
      bodies: m.bodies.length,
      bodiesByRole: byRole,
      checkedPairs: m.pairs.length,
      sessionWatched: this.watched.size,
      collisions: pairs.length,
      pairs,
      ...(includeBodies ? {
        bodyList: m.bodies.map((b) => ({ path: b.key, role: b.role, meshes: b.meshes.length, aabbOnly: b.aabbOnly })),
      } : {}),
    });
  }

  @McpTool(
    'Clear the latched collision pairs (outlines, cards, signals). A pair that still intersects is reported '
    + 'again on the next tick. clearWatch=true also removes the session roles set by web_collision_watch.',
    { readOnly: false },
  )
  async webCollisionReset(
    @McpParam('clearWatch', 'Also remove the session roles of web_collision_watch (default false)', 'boolean') clearWatch?: boolean,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const m = v.collisionManager;
    m.reset();
    let removed = 0;
    if (clearWatch) {
      for (const node of this.watched.keys()) { m.unregister(node); removed++; }
      this.watched.clear();
      m.invalidate();
    }
    return JSON.stringify({ ok: true, removedWatch: removed, remainingWatch: this.watched.size });
  }
}
