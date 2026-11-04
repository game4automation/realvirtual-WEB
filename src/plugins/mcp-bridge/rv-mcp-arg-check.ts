// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-arg-check — no MCP argument is dropped silently (plan-2005 F6).
 *
 * The dispatcher builds a tool's positional arguments from its declared
 * `@McpParam` names. Before this check, every OTHER key a caller sent was
 * discarded without a word — which is how `web_logs({types: …})` and
 * `web_signal_list({name: …})` looked like "the filter is ignored" (2026-10-26).
 *
 * The rule, applied once at the one dispatch point (`_handleCall`):
 *
 * - a declared parameter passes;
 * - a `_`-prefixed key passes untouched — the macro meta arguments
 *   (`_reason` / `_source` / `_confidence`) and any future meta key are not
 *   tool parameters and are split off or ignored further down;
 * - a declared ALIAS is renamed to its parameter (the spellings agents actually
 *   used: `web_logs types → category`, `web_signal_list name / pattern → filter`);
 * - anything else is an error that names the allowed parameters, so an AI
 *   client corrects itself in one round trip.
 */

/** Per tool: alias → declared parameter. */
export const TOOL_ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  web_logs: { types: 'category' },
  web_signal_list: { name: 'filter', pattern: 'filter' },
};

/** The error prefix every client can match on. */
export const UNKNOWN_PARAM_PREFIX = 'unknown-param:';

/** `_`-meta keys pass — except the prototype key, which would rewrite the args object. */
function isMeta(key: string): boolean {
  return key.startsWith('_') && key !== '__proto__';
}

export type ToolArgCheck =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Check one call's arguments against the tool's declared parameter names.
 * Returns the (alias-mapped) arguments, or an `unknown-param:` error.
 */
export function checkToolArgs(
  toolName: string,
  declared: readonly string[],
  args: Readonly<Record<string, unknown>> | null | undefined,
  aliases: Readonly<Record<string, string>> | undefined = TOOL_ARG_ALIASES[toolName],
): ToolArgCheck {
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  const src = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  // Declared keys first, so an alias never overwrites the real parameter silently.
  for (const [key, value] of Object.entries(src)) {
    if (isMeta(key) || declared.includes(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(src)) {
    if (isMeta(key) || declared.includes(key)) continue;
    const target = aliases?.[key];
    if (target && declared.includes(target)) {
      if (target in out) {
        return {
          ok: false,
          error: `${UNKNOWN_PARAM_PREFIX} '${key}' is an alias of '${target}' of ${toolName} — pass only one of them.`,
        };
      }
      out[target] = value;
      continue;
    }
    unknown.push(key);
  }
  if (unknown.length > 0) {
    const names = unknown.map((k) => `'${k}'`).join(', ');
    const verb = unknown.length === 1 ? 'is not a parameter' : 'are not parameters';
    const allowed = declared.length > 0 ? declared.join(', ') : '(none)';
    return { ok: false, error: `${UNKNOWN_PARAM_PREFIX} ${names} ${verb} of ${toolName}. Allowed: ${allowed}` };
  }
  return { ok: true, args: out };
}
