// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Kiosk Mode — Configuration normalization + URL parameter parsing.
 *
 * Three-layer config (priority high → low):
 *  1. URL parameters (`?kiosk=60`, `?kiosk=off`, `?kiosk=now`) — runtime override
 *  2. settings.json `pluginConfig.kiosk.*` — deploy-time config
 *  3. Hardcoded defaults (disabled by default — opt-in only)
 *
 * `?kiosk=0` is explicitly rejected (use `?kiosk=now` for instant activation)
 * to prevent busy-loop on exit→restart cycle.
 *
 * All values clamped to safe ranges (minimum 5s for idle timeout).
 */

// ─── Public types ──────────────────────────────────────────────────────

/** @public @stable v1 */
export interface KioskConfig {
  enabled: boolean;
  idleTimeoutSeconds: number;
  hintIntervalSeconds: number;
  exitOnAnyInput: boolean;
  pauseOnHidden: boolean;
  respectReducedMotion: boolean;
  cycleLimit: number;                    // 0 = infinite
  cameraAnimationTimeoutMs: number;
  maxDwellMs: number;
  maxConcurrentMessages: number;
}

/** Conservative safe defaults — opt-in only. @public @stable v1 */
export const DEFAULT_KIOSK_CONFIG: KioskConfig = {
  enabled: false,                         // OPT-IN — zero impact on existing deployments
  idleTimeoutSeconds: 60,
  hintIntervalSeconds: 15,
  exitOnAnyInput: true,
  pauseOnHidden: true,
  respectReducedMotion: true,
  cycleLimit: 0,
  cameraAnimationTimeoutMs: 5000,
  maxDwellMs: 60000,
  maxConcurrentMessages: 5,
};

// ─── Normalization (clamps invalid values to safe defaults) ─────────────

/** @public — consume raw settings.json input, returning a fully-populated KioskConfig. */
export function normalizeKioskConfig(raw: unknown): KioskConfig {
  const cfg = (raw as Partial<KioskConfig> | null | undefined) ?? {};
  const toNum = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const timeout = toNum(cfg.idleTimeoutSeconds);
  const hint = toNum(cfg.hintIntervalSeconds);
  const cycle = toNum(cfg.cycleLimit);
  const camTimeout = toNum(cfg.cameraAnimationTimeoutMs);
  const maxDwell = toNum(cfg.maxDwellMs);
  const maxMsg = toNum(cfg.maxConcurrentMessages);
  return {
    enabled: cfg.enabled === true,                                    // strict — only boolean `true` enables
    idleTimeoutSeconds: timeout !== null && timeout >= 5 ? timeout : DEFAULT_KIOSK_CONFIG.idleTimeoutSeconds,
    hintIntervalSeconds: hint !== null && hint >= 5 ? hint : DEFAULT_KIOSK_CONFIG.hintIntervalSeconds,
    exitOnAnyInput: cfg.exitOnAnyInput !== false,                     // default true
    pauseOnHidden: cfg.pauseOnHidden !== false,
    respectReducedMotion: cfg.respectReducedMotion !== false,
    cycleLimit: cycle !== null ? Math.max(0, cycle) : DEFAULT_KIOSK_CONFIG.cycleLimit,
    cameraAnimationTimeoutMs: camTimeout !== null ? Math.max(500, camTimeout) : DEFAULT_KIOSK_CONFIG.cameraAnimationTimeoutMs,
    maxDwellMs: maxDwell !== null ? Math.max(100, maxDwell) : DEFAULT_KIOSK_CONFIG.maxDwellMs,
    maxConcurrentMessages: maxMsg !== null ? Math.max(1, Math.min(20, maxMsg)) : DEFAULT_KIOSK_CONFIG.maxConcurrentMessages,
  };
}

// ─── URL parameter parsing (highest precedence) ─────────────────────────

/**
 * Apply URL `?kiosk=...` parameter on top of a base config.
 *
 * Recognised values:
 *  - `?kiosk=off`    → force disabled
 *  - `?kiosk=now`    → enable + start immediately (idleTimeoutSeconds=0)
 *  - `?kiosk=N`      → enable + idleTimeoutSeconds=max(5, N)    (N >= 1)
 *  - anything else   → warn + return config unchanged
 *
 * `?kiosk=0`, negative numbers, NaN, 'abc', empty are all rejected.
 *
 * @public
 */
export function applyUrlOverrides(cfg: KioskConfig, params: URLSearchParams): KioskConfig {
  const kiosk = params.get('kiosk');
  if (kiosk === null) return cfg;
  if (kiosk === 'off') return { ...cfg, enabled: false };
  if (kiosk === 'now') return { ...cfg, enabled: true, idleTimeoutSeconds: 0 };
  const n = parseInt(kiosk, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[kiosk] Ignoring invalid ?kiosk=${kiosk} (use ?kiosk=now for instant, ?kiosk=off to disable, or positive integer seconds)`);
    return cfg;
  }
  return { ...cfg, enabled: true, idleTimeoutSeconds: Math.max(5, n) };
}

// ─── Camera argument validation (guards against NaN/Infinity in tours) ──

/**
 * Validates camera action coordinates. Throws on NaN, Infinity, or wrong-length
 * arrays. Called both at tour registration time and at dispatch time.
 *
 * @public
 */
export function validateCameraArgs(
  position: unknown,
  target: unknown,
): { position: [number, number, number]; target: [number, number, number] } {
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) {
    throw new Error(`Invalid camera position: ${JSON.stringify(position)}`);
  }
  if (!Array.isArray(target) || target.length !== 3 || !target.every(Number.isFinite)) {
    throw new Error(`Invalid camera target: ${JSON.stringify(target)}`);
  }
  return {
    position: [position[0] as number, position[1] as number, position[2] as number],
    target: [target[0] as number, target[1] as number, target[2] as number],
  };
}

// ─── Reduced-motion detection ───────────────────────────────────────────

/** @public — returns true if user has `prefers-reduced-motion: reduce` set. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}
