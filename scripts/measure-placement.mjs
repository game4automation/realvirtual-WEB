// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * measure-placement — acceptance measurement for the planner bake pipeline
 * (plan-753 Phase 0). Places one catalog asset N times through the raw MCP
 * endpoint of a RUNNING realvirtual CONNECT gateway, then reads
 * `web_layout_timings` and prints Markdown tables: per placement (total,
 * phases, first frame, draw calls), the decode and bake rings, and every long
 * task >= 100 ms.
 *
 * Raw JSON-RPC over MCP Streamable HTTP — no SDK, no Node bridge, nothing but
 * Node 20+ `fetch`. Each request is one `POST /mcp`; the server answers either
 * plain JSON or a one-event SSE stream, both are handled.
 *
 * Handshake (plan-753 Phase 5): CONNECT runs the C# MCP SDK in session mode
 * (`Stateless = false`) — `initialize` answers with an `Mcp-Session-Id` header
 * that every later request carries. The `notifications/initialized`
 * notification is sent WITHOUT an `id` (a notification with an id is a request
 * the server rightly answers with -32601 "method not found"), and whatever the
 * server says to it is ignored: the session is already open after
 * `initialize`. Every response is awaited and the session is closed with
 * `DELETE /mcp` at the end, so the process exits cleanly (no dangling
 * keep-alive socket — Node 24 used to die in libuv's `async.c` assertion on
 * `process.exit` with one still open).
 *
 * Usage:
 *   node scripts/measure-placement.mjs [--catalog <id>] [--count <n>] [--spacing <m>]
 *                                      [--base http://127.0.0.1:5100] [--json]
 *
 * `--catalog` takes anything `web_layout_place` resolves (Phase 0 onwards): a
 * bundled-library catalogId (default
 * `realvirtual-library-pallethandling-rollconveyor-2m-glb`), a project
 * document's `documentId`, or a `project:<path>` id as listed by
 * `web_document_list`. Defaults: count 3, spacing 2.5 m along X,
 * base http://127.0.0.1:5100.
 *
 * Memory `webviewer-connect-tool-timeout-hidden-tab`: a placement can exceed
 * the CONNECT tool timeout (15 s) on a big asset — the call still executes and
 * the timing record still lands in the ring, so the table is read AFTER all
 * placements regardless of individual call results, and the report is printed
 * even when some placements failed. Keep the viewer tab visible while
 * measuring: rAF-based numbers lie in a hidden tab.
 *
 * Exit codes: 0 = table printed, every call succeeded · 1 = the gateway
 * answered an error (a table is still printed when the timings could be read)
 * · 2 = the gateway is not reachable.
 */

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) { args[key] = true; } else { args[key] = next; i++; }
}

const BASE = String(args.base ?? 'http://127.0.0.1:5100').replace(/\/+$/u, '');
const MCP_URL = `${BASE}/mcp`;
const CATALOG = String(args.catalog ?? 'realvirtual-library-pallethandling-rollconveyor-2m-glb');
const COUNT = Math.max(1, Number(args.count ?? 3) | 0);
const SPACING = Number(args.spacing ?? 2.5);
const JSON_OUT = args.json === true;

let nextId = 1;
let sessionId = null;
/** Set once any call failed; decides the exit code after the report. */
let hadError = false;

const fail = (msg) => { hadError = true; console.error(msg); };

function headers() {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    // One request per connection: nothing to keep alive across the exit.
    connection: 'close',
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

/** Parse a JSON-RPC response body — plain JSON or a single-message SSE stream. */
function parseBody(contentType, text) {
  if (contentType.includes('text/event-stream')) {
    let msg;
    // Take the last `data:` line that parses as a JSON-RPC response.
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed && parsed.jsonrpc === '2.0' && 'id' in parsed) msg = parsed;
      } catch { /* keep-alive or partial line */ }
    }
    return msg;
  }
  if (text.trim().length > 0) {
    try { return JSON.parse(text); } catch { return undefined; }
  }
  return undefined;
}

/** One JSON-RPC request. Returns `{ result }` or `{ error }` — never exits
 *  (except when the gateway is unreachable, which nothing downstream can fix). */
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
  let res;
  try {
    res = await fetch(MCP_URL, { method: 'POST', headers: headers(), body });
  } catch (e) {
    console.error(`cannot reach ${MCP_URL}: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!res.ok) return { error: `${method} → HTTP ${res.status}: ${text.slice(0, 400)}` };
  const msg = parseBody(res.headers.get('content-type') ?? '', text);
  if (!msg) return { error: `${method} → empty or unparsable response` };
  if (msg.error) return { error: `${method} → JSON-RPC error ${msg.error.code}: ${msg.error.message}` };
  return { result: msg.result };
}

/** A JSON-RPC notification (no `id`). Best effort: the reply is awaited so the
 *  socket is drained, but its content — including a -32601 — is irrelevant. */
async function notify(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params });
  try {
    const res = await fetch(MCP_URL, { method: 'POST', headers: headers(), body });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    await res.text();
  } catch { /* optional by design */ }
}

/** Close the Streamable HTTP session (SDK: DELETE with the session header). */
async function closeSession() {
  if (!sessionId) return;
  try {
    const res = await fetch(MCP_URL, { method: 'DELETE', headers: headers() });
    await res.text();
  } catch { /* the server reaps idle sessions anyway */ }
}

/** tools/call → the tool's JSON payload (the first text content block, parsed),
 *  or `{ error }`. */
async function callTool(name, toolArgs) {
  const { result, error } = await rpc('tools/call', { name, arguments: toolArgs });
  if (error) return { error };
  const block = result?.content?.find((c) => c.type === 'text');
  const raw = block?.text ?? '';
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  if (result?.isError || (payload && typeof payload === 'object' && 'error' in payload)) {
    return { error: String(payload?.error ?? raw) };
  }
  return payload;
}

const ms = (v) => (v === undefined || v === null ? '' : `${Math.round(v)}`);
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (header, rows) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n');
const phaseText = (phases) => Object.entries(phases ?? {}).map(([k, v]) => `${k}=${ms(v)}`).join(' ');

async function main() {
  // ── 1. Handshake ────────────────────────────────────────────────────
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'measure-placement', version: '1.1.0' },
  });
  if (init.error) { fail(init.error); return; }
  await notify('notifications/initialized', {});

  const status = await callTool('web_status', {});
  if (status?.error) {
    if (String(status.error).includes('LICENSE_REQUIRED')) { fail(`web_status: ${status.error}`); return; }
    fail(`web_status: ${status.error} — is a viewer tab connected to CONNECT?`);
    return;
  }

  // ── 2. Clear rings, place N times ───────────────────────────────────
  const cleared = await callTool('web_layout_timings', { clear: true });
  if (cleared?.error) fail(`web_layout_timings(clear): ${cleared.error}`);

  const placeResults = [];
  for (let i = 0; i < COUNT; i++) {
    const x = i * SPACING;
    const t0 = performance.now();
    const r = await callTool('web_layout_place', { catalogId: CATALOG, x, y: 0, z: 0 });
    placeResults.push({ i, x, wallMs: performance.now() - t0, ...(r ?? {}) });
    if (r?.error) fail(`placement ${i + 1}/${COUNT}: ${r.error} (the timing record may still land in the ring)`);
  }

  // ── 3. Read the rings ───────────────────────────────────────────────
  const timings = await callTool('web_layout_timings', { clear: false });
  if (timings?.error) { fail(`web_layout_timings: ${timings.error}`); return; }

  if (JSON_OUT) {
    console.log(JSON.stringify({ catalog: CATALOG, count: COUNT, spacing: SPACING, placeResults, timings }, null, 2));
    return;
  }

  const out = [];
  out.push(`# Placement measurement — \`${CATALOG}\` × ${COUNT} (spacing ${SPACING} m)`);
  out.push('');
  out.push(`Gateway: ${BASE} · document: ${status?.document ?? status?.model ?? status?.scene ?? '?'} · read at t=${ms(timings.now)} ms`);
  out.push('');

  out.push('## Placements (client wall time + `web_layout_place` placeMs)');
  out.push(table(
    ['#', 'x [m]', 'id', 'wall [ms]', 'placeMs'],
    placeResults.map((p) => [p.i + 1, p.x, p.id ?? p.error ?? '', ms(p.wallMs), ms(p.placeMs)]),
  ));
  out.push('');

  const placements = Array.isArray(timings.placements) ? timings.placements : [];
  out.push('## Scene-registration ring (`placements`)');
  out.push(table(
    ['op', 'id', 'mode', 'totalMs', 'firstFrameMs', 'drawCallsAfter', 'phases'],
    placements.map((t) => [t.op, t.id, t.mode ?? '', ms(t.totalMs), ms(t.firstFrameMs), t.drawCallsAfter ?? '', phaseText(t.phases)]),
  ));
  out.push('');

  const decode = Array.isArray(timings.decode) ? timings.decode : [];
  out.push('## Decode ring (`decode`, once per asset per document)');
  out.push(table(
    ['cacheKey', 'totalMs', 'meshes', 'triangles', 'phases'],
    decode.map((d) => [d.cacheKey, ms(d.totalMs), d.meshes ?? '', d.triangles ?? '', phaseText(d.phases)]),
  ));
  out.push('');

  const bake = Array.isArray(timings.bake) ? timings.bake : [];
  out.push('## Bake ring (`bake`, once per baked asset)');
  out.push(table(
    ['assetId', 'totalMs', 'chunks', 'vertices', 'triangles', 'phases'],
    bake.map((b) => [b.assetId, ms(b.totalMs), b.chunks, b.vertices, b.triangles, phaseText(b.phases)]),
  ));
  out.push('');

  const longTasks = Array.isArray(timings.longTasks) ? timings.longTasks : [];
  out.push('## Long tasks >= 100 ms (main-thread blocks since the clear)');
  out.push(table(['start [ms]', 'ms'], longTasks.map((l) => [ms(l.start), ms(l.ms)])));
  out.push('');

  if (timings.batch) {
    out.push('## Batch table');
    out.push('```json');
    out.push(JSON.stringify(timings.batch));
    out.push('```');
    out.push('');
  }

  const totals = placements.filter((t) => t.op === 'placeComponent').map((t) => t.totalMs);
  if (totals.length > 0) {
    const sum = totals.reduce((a, b) => a + b, 0);
    out.push(`**placeComponent**: n=${totals.length} · mean ${ms(sum / totals.length)} ms · max ${ms(Math.max(...totals))} ms · long tasks ${longTasks.length}`);
  }
  if (hadError) out.push('', '_Partial result: at least one call failed (see stderr)._');
  console.log(out.join('\n'));
}

try {
  await main();
} catch (e) {
  fail(`unexpected: ${e instanceof Error ? e.stack ?? e.message : e}`);
} finally {
  await closeSession();
}
process.exitCode = hadError ? 1 : 0;
