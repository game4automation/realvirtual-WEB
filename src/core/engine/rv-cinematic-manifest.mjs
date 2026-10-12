// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cinematic-manifest.mjs — the portable half of a cinematic recording's on-disk contract
 * (plan-550 F3/F10, moved here by plan-551 F5/F17/F24).
 *
 * A cinematic run writes `frame-%06d.png` files plus a manifest `cinematic.json` into one
 * folder; a restarted run resumes at the first missing frame, but only while the manifest
 * still describes the same recording. Two writers share these rules:
 *
 *   - the CLI (`npm run record -- --quality cinematic`, Node fs — the file-system adapter stays
 *     in `scripts/lib/rv-cinematic-frames.mjs`, which re-exports everything below);
 *   - the viewer's "Record video" dialog (File System Access API, commercial build).
 *
 * Deliberately WITHOUT imports and without Node or DOM APIs: plain JS, so the CLI (Node), the
 * browser bundle and both test runners load the very same file. Hashing goes through an
 * injected digest — `node:crypto` in the CLI (synchronous), `crypto.subtle` in the browser
 * (asynchronous); both see the same UTF-8 bytes, so both produce the same hash.
 */

export const MANIFEST_NAME = 'cinematic.json';
export const MANIFEST_VERSION = 1;
/** Disk space reserved per remaining frame (1080p PNG ≈ 1.2–1.3 MB, spike) × 1.2 margin. */
export const BYTES_PER_FRAME_ESTIMATE = 1.5 * 1024 * 1024;
export const DISK_MARGIN = 1.2;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IEND = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/** `frame-000042.png` for index 42. */
export function frameFileName(index) {
  return `frame-${String(index).padStart(6, '0')}.png`;
}

/** Index of a frame file name, or -1. */
export function frameIndexOf(name) {
  const m = /^frame-(\d{6,})\.png$/.exec(name);
  return m ? Number(m[1]) : -1;
}

/** True when the bytes (any Uint8Array, a Node Buffer included) are a complete PNG: signature + IEND chunk. */
export function isCompletePng(bytes) {
  if (!bytes || bytes.length < PNG_SIGNATURE.length + 12) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  const off = bytes.length - IEND.length;
  for (let i = 0; i < IEND.length; i++) if (bytes[off + i] !== IEND[i]) return false;
  return true;
}

/**
 * Classifies the entry names of an out dir: the frame indices below `frames` and the temp
 * files of an interrupted CLI write (`*.png.tmp`). Every other name is ignored.
 */
export function classifyFrameNames(names, frames) {
  const present = [];
  const tempFiles = [];
  for (const name of names) {
    if (name.endsWith('.png.tmp')) { tempFiles.push(name); continue; }
    const i = frameIndexOf(name);
    if (i >= 0 && i < frames) present.push(i);
  }
  present.sort((a, b) => a - b);
  return { present: [...new Set(present)], tempFiles };
}

/**
 * Resume point of a set of present frames: the first missing index and the missing frames
 * BELOW the highest present one (a run is re-rendered from `firstMissing` on, so these are
 * only reported).
 */
export function resumePoint(present, frames) {
  const set = new Set(present);
  let firstMissing = frames;
  for (let i = 0; i < frames; i++) if (!set.has(i)) { firstMissing = i; break; }
  const maxPresent = set.size ? Math.max(...set) : -1;
  const gaps = [];
  for (let i = firstMissing; i < maxPresent; i++) if (!set.has(i)) gaps.push(i);
  return { existing: [...set].sort((a, b) => a - b), firstMissing, gaps };
}

/** JSON with sorted keys (undefined members dropped) — the form every hash and comparison uses. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/** UTF-8 bytes of a string (what `createHash().update(string)` hashes in Node). */
export function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

/** Stable options hash with a SYNCHRONOUS digest (`bytes → hex`), e.g. Node `createHash`. */
export function optionsHashSync(options, digestHexSync) {
  return digestHexSync(utf8Bytes(stableStringify(options))).slice(0, 16);
}

/** Stable options hash with an ASYNCHRONOUS digest (`bytes → Promise<hex>`), e.g. `crypto.subtle`. */
export async function optionsHashAsync(options, digestHex) {
  return (await digestHex(utf8Bytes(stableStringify(options)))).slice(0, 16);
}

/**
 * Fields that must be identical for a resume, in the order they are reported. A field whose
 * value is an object is compared by its stable JSON. `cameraPoses` (plan-551 F20) is the
 * RESOLVED camera — position, target, fov, projection and zoom at three frames — so a resume
 * never silently continues with a different view. `lookOptions` (the requested look options,
 * plan-553) comes before `optionsHash` so a refusal names it; `look` is the RESOLVED look (HDR path,
 * parameters, algorithm versions, fallbacks, override content hash) the page reports.
 * plan-554: `motionBlur` = the REQUESTED blur (also in `optionsHash`, before it so a refusal names
 * it — a pre-554 folder has none and is refused); `resolvedBlur` = what the frame source resolved
 * it to (`pathA-v1` | `off`), known only after the setup — the CLI and the dialog sink compare it
 * a second time there, before the first frame (fields a current manifest lacks are skipped).
 */
export const RESUME_FIELDS = [
  'version', 'lookOptions', 'motionBlur', 'hmi', 'hmiOpen', 'viewport', 'layoutFingerprint', 'optionsHash', 'frames', 'fps', 'width', 'height', 'samples', 'denoise', 'warmupSeconds',
  'cameraPath', 'cameraPoses', 'model', 'modelHash', 'hdr', 'hdrHash', 'environment', 'lights', 'renderer',
  'tracerVersion', 'denoiserVersion', 'seedRule', 'look', 'resolvedBlur',
];

/**
 * Resume fields with a default (plan-556 F8): compared even when one side lacks them — a folder
 * without `hmi` is an `off` recording — so an off / composite mismatch names `hmi`. Every other
 * field a current manifest lacks is skipped.
 */
export const DEFAULTED_RESUME_FIELDS = { hmi: 'off' };

/** True when a recording includes the HMI (plan-556): `hmi` is `composite` or `layer`. */
export function hmiOn(options) {
  return !!options && typeof options.hmi === 'string' && options.hmi !== 'off';
}

/**
 * The HMI options as they enter the hash and the manifest (plan-556 F8) — ONLY when the HMI is on,
 * so the hash of every recording without HMI stays bit-identical (golden values). `viewport` is
 * the browser viewport the HMI was laid out in (CLI: = the output size; dialog: + DPR);
 * `layoutFingerprint` (dialog) = ids, collapsed state and rects of the visible panels.
 */
export function cinematicHmiOptions(options) {
  if (!hmiOn(options)) return {};
  return {
    hmi: options.hmi,
    hmiOpen: Array.isArray(options.hmiOpen) ? [...options.hmiOpen] : [],
    viewport: options.viewport ?? null,
    ...(options.layoutFingerprint !== undefined ? { layoutFingerprint: options.layoutFingerprint } : {}),
  };
}

/**
 * Defaults of the plan-553 look options — a mirror of `CINEMATIC_DEFAULT_LOOK`,
 * `CINEMATIC_DEFAULT_VIGNETTE` and `CINEMATIC_DEFAULT_FSTOP` in rv-cinematic-hook.ts (this file
 * has no imports on purpose; tests/rv-video-cinematic.test.ts keeps both in step).
 */
export const LOOK_OPTION_DEFAULTS = { look: 'studio', vignette: 0.15, fStop: 5.6 };

/**
 * The look options of a recording as they enter the hash and the manifest (plan-553 F7): defaults
 * filled in, the f-number only with DoF, the override CONTENT (not a file name).
 */
export function cinematicLookOptions(options) {
  const dof = options.dof === true;
  return {
    look: options.look ?? LOOK_OPTION_DEFAULTS.look,
    dof,
    fStop: dof ? (options.fStop ?? LOOK_OPTION_DEFAULTS.fStop) : null,
    vignette: options.vignette ?? LOOK_OPTION_DEFAULTS.vignette,
    materialPresets: options.materialPresets !== false,
    materialOverrides: options.materialOverrides ?? null,
  };
}

/**
 * Defaults of the plan-554 motion blur — a mirror of `CINEMATIC_DEFAULT_MOTION_BLUR`,
 * `CINEMATIC_DEFAULT_SHUTTER_DEG` and `CINEMATIC_DEFAULT_BLUR_SUBFRAMES` in rv-cinematic-hook.ts
 * (tests/rv-video-cinematic.test.ts keeps both in step).
 */
export const MOTION_BLUR_DEFAULTS = { enabled: true, shutterDeg: 180, subFrames: 8 };

/**
 * The REQUESTED motion blur as it enters the hash and the manifest (plan-554 F7) — the same
 * canonical form `normalizeMotionBlur` produces: off (`enabled: false` or shutter 0) is always
 * `{ enabled: false, shutterDeg: 0, subFrames: 1 }`.
 */
export function cinematicMotionBlurOptions(options) {
  const mb = options?.motionBlur ?? {};
  const shutterDeg = mb.shutterDeg ?? MOTION_BLUR_DEFAULTS.shutterDeg;
  const enabled = (mb.enabled ?? MOTION_BLUR_DEFAULTS.enabled) !== false && shutterDeg > 0;
  if (!enabled) return { enabled: false, shutterDeg: 0, subFrames: 1 };
  return { enabled: true, shutterDeg: Math.round(shutterDeg * 100) / 100, subFrames: mb.subFrames ?? MOTION_BLUR_DEFAULTS.subFrames };
}

/**
 * The manifest fields of the RESOLVED blur (plan-554 F7) from the setup info's `motionBlur`
 * (`{ resolved, reason, subFrames }`); a setup without it (a pre-554 page) resolves to `off`.
 */
export function blurManifestFields(resolution) {
  return {
    resolvedBlur: resolution?.resolved ?? 'off',
    blurFallbackReason: resolution?.reason ?? null,
    blurSubFrames: resolution?.subFrames ?? 1,
  };
}

/** Wording of the CLI (default) — the browser passes its own. */
export const CLI_WORDING = {
  place: 'The out dir',
  advice: 'Use a new --out-dir or delete the frames to start over.',
};

/**
 * Compares a stored manifest with the current one. Returns null when a resume is allowed,
 * else a message naming the first differing field.
 */
export function compareManifest(stored, current, wording = CLI_WORDING) {
  for (const f of RESUME_FIELDS) {
    const fallback = DEFAULTED_RESUME_FIELDS[f];
    if (!(f in current) && fallback === undefined) continue; // not known yet (e.g. filled after setup)
    // `?? "undefined"`: a field the stored manifest lacks (an older version) is named, not a crash.
    const a = stableStringify(stored?.[f] ?? fallback) ?? 'undefined';
    const b = stableStringify(current[f] ?? fallback) ?? 'undefined';
    if (a !== b) {
      return `${wording.place} holds frames of a different recording: "${f}" differs (stored ${truncate(a)}, now ${truncate(b)}). ${wording.advice}`;
    }
  }
  return null;
}

function truncate(s) {
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/**
 * The options of a cinematic recording that change the image or the timing — what
 * `optionsHash` covers. Same object for the CLI and the viewer dialog.
 */
export function cinematicHashedOptions(options, hdrFileHash) {
  return {
    width: options.width, height: options.height, fps: options.fps, seconds: options.seconds,
    warmupSeconds: options.warmupSeconds, samples: options.samples, denoise: options.denoise,
    path: options.path, hdrFile: hdrFileHash ?? null,
    ...cinematicLookOptions(options),
    motionBlur: cinematicMotionBlurOptions(options),
    // plan-556 F8: present only with the HMI on — the hash of every other recording is unchanged.
    ...cinematicHmiOptions(options),
  };
}

/**
 * The part of the manifest known before the page renders, given the options hash. The
 * readable copies next to the hash make a refusal name the field.
 */
export function cinematicBaseManifestWith(options, optionsHashHex) {
  return {
    version: MANIFEST_VERSION,
    optionsHash: optionsHashHex,
    frames: Math.round(options.seconds * options.fps),
    fps: options.fps,
    width: options.width,
    height: options.height,
    samples: options.samples,
    denoise: options.denoise,
    warmupSeconds: options.warmupSeconds,
    cameraPath: options.path,
    // Readable copy (the override content only as part of optionsHash); a refusal names `lookOptions`.
    lookOptions: (({ materialOverrides, ...rest }) => ({ ...rest, materialOverrides: materialOverrides ? 'set' : null }))(cinematicLookOptions(options)),
    // plan-554: readable copy of the requested blur (also hashed); a refusal names `motionBlur`.
    motionBlur: cinematicMotionBlurOptions(options),
    // plan-556: readable copies of the HMI options (also hashed) — only with the HMI on.
    ...cinematicHmiOptions(options),
  };
}

/** {@link cinematicBaseManifestWith} with an asynchronous digest (browser). */
export async function cinematicBaseManifestAsync(options, hdrFileHash, digestHex) {
  return cinematicBaseManifestWith(options, await optionsHashAsync(cinematicHashedOptions(options, hdrFileHash), digestHex));
}

/**
 * Whether a folder may be used for this recording. `existingFrames` = frame files found,
 * `stored` = the parsed manifest or null. Returns null when it may (a fresh start or a
 * resume), else the refusal.
 */
export function resumeRefusal(stored, current, existingFrames, wording = CLI_WORDING) {
  if (existingFrames > 0 && !stored) {
    return `${wording.place} holds frames but no ${MANIFEST_NAME} — it is unknown which recording they belong to. ${wording.advice}`;
  }
  if (existingFrames > 0) return compareManifest(stored, current, wording);
  return null;
}

/** "1 h 02 min" / "3 min 05 s" / "12 s". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(r).padStart(2, '0')} s`;
  return `${r} s`;
}
