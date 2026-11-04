// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-vendors.ts — the vendor catalogue and THE lazy boundary of the
 * robot program export (plan-773 Phase 5, F17 / §2.5).
 *
 * ## What "lazy" means here, and what it does not
 *
 * The house rule since 2026-10-23 is that the FEATURE CODE is lazy, not merely
 * a binary blob, and that the proof is the BUILD IMPORT GRAPH rather than a
 * network log — a request that never happens proves nothing about what is
 * already sitting in the entry chunk. Two levels therefore:
 *
 * 1. **Nothing static imports `src/core/robot-program/**`.** Both callers (the
 *    `ik.program.export` command behind `web_robot_program_export`, and the
 *    IKPath inspector's download button) reach the export through `import()`.
 * 2. **Each vendor is its own chunk.** {@link ROBOT_VENDORS} holds one
 *    `import()` per vendor, so an ABB export never downloads the SEW formatter.
 *    That per-vendor split is the concrete thing plan-773 §2.3 bought by
 *    choosing a TypeScript port over a shared WASM core, which loads whole or
 *    not at all.
 *
 * Guarded by `tests/robot-export-lazy.node.test.ts`, which walks the static
 * graph from `src/main.ts` the same way `tests/bundle-eager-imports.node.test.ts`
 * does.
 *
 * ## Why the metadata is duplicated out of the vendor classes
 *
 * {@link RobotVendorInfo} repeats each vendor's display name and extension so a
 * caller can LIST the vendors, validate an id and word a refusal without
 * loading a single formatter — which is the whole point of the boundary. The
 * duplication is a real drift risk, so it is asserted: the lazy test loads every
 * vendor and compares both strings against this table.
 */

import type { RobotPostProcessor } from './rv-robot-postprocessor';

/** The vendor ids this phase ships (plan-773 E2 order: ABB, then SEW). */
export const ROBOT_VENDOR_IDS = ['abb-rapid', 'sew-srlprg'] as const;

/** One of {@link ROBOT_VENDOR_IDS}. */
export type RobotVendorId = typeof ROBOT_VENDOR_IDS[number];

/** What a caller can know about a vendor WITHOUT loading its chunk. */
export interface RobotVendorInfo {
  id: RobotVendorId;
  /** Must equal the loaded class's `displayName` (asserted). */
  displayName: string;
  /** Must equal the loaded class's `fileExtension` (asserted). */
  fileExtension: string;
  /** One line for a tool answer / a dropdown. */
  description: string;
}

/** Vendor metadata, id → info. Static: no vendor chunk is touched by reading it. */
export const ROBOT_VENDORS: Readonly<Record<RobotVendorId, RobotVendorInfo>> = Object.freeze({
  'abb-rapid': {
    id: 'abb-rapid',
    displayName: 'ABB RAPID',
    fileExtension: '.mod',
    description: 'ABB RAPID module (MODULE / PROC main). Axis-based uses MoveAbsJ + jointtarget and is '
      + 'robconf-free; Cartesian uses MoveJ/MoveL + robtarget. tooldata/wobjdata fall back to tool0/wobj0.',
  },
  'sew-srlprg': {
    id: 'sew-srlprg',
    displayName: 'SEW MOVI-C (.srlprg)',
    fileExtension: '.srlprg',
    description: 'SEW MOVI-C / MOVIKIT Robotics sequence program. PTP_J for joint moves, LIN for Cartesian. '
      + 'There is no public language reference — the emitted text form is observed, so KINEMATIC id, '
      + 'MotionSet and the REALVAR mapping must be verified in MOVISUITE.',
  },
});

/** Narrowing guard for a wire value. */
export function isRobotVendorId(v: unknown): v is RobotVendorId {
  return typeof v === 'string' && (ROBOT_VENDOR_IDS as readonly string[]).includes(v);
}

/** Options every vendor understands, plus the vendor-specific extras. */
export interface RobotPostProcessorOptions {
  /** true (default) => joint moves; false => Cartesian. plan-773 E9. */
  axisBased?: boolean;
  /** ABB: snap the linear speed to a predefined `v####`. Default true. */
  snapToPredefined?: boolean;
  /** SEW: `// KINEMATIC:` header id. Default 1. */
  kinematicNumber?: number;
  /** SEW: `MotionSet := <n>`. Default 1. */
  motionSet?: number;
  /** SEW: first `REALVAR[]` slot. Default 10. */
  realVarBaseIndex?: number;
  /** SEW: `// CoordinateSystem := <x>`. Default `Base`. */
  coordinateSystem?: string;
  /** SEW: generation timestamp. Default now — set it to make output stable. */
  generatedAt?: Date;
  /** SEW: program UUID. Default random — set it to make output stable. */
  uuid?: string;
}

/**
 * Load ONE vendor's chunk and construct its postprocessor.
 *
 * The `import()` specifiers are written out literally, one per branch, on
 * purpose: a computed specifier (`./vendors/${id}`) makes Rollup emit a glob of
 * every matching file into a single chunk, which would silently undo the
 * per-vendor split this module exists for.
 */
export async function loadRobotPostProcessor(
  id: RobotVendorId,
  options: RobotPostProcessorOptions = {},
): Promise<RobotPostProcessor> {
  let pp: RobotPostProcessor;
  switch (id) {
    case 'abb-rapid': {
      const { ABBRapidPostProcessor } = await import('./vendors/rv-abb-rapid');
      pp = new ABBRapidPostProcessor({ snapToPredefined: options.snapToPredefined });
      break;
    }
    case 'sew-srlprg': {
      const { SewSrlPrgPostProcessor } = await import('./vendors/rv-sew-srlprg');
      pp = new SewSrlPrgPostProcessor({
        kinematicNumber: options.kinematicNumber,
        motionSet: options.motionSet,
        realVarBaseIndex: options.realVarBaseIndex,
        coordinateSystem: options.coordinateSystem,
        generatedAt: options.generatedAt,
        uuid: options.uuid,
      });
      break;
    }
    default: {
      // Exhaustive by construction; the throw is for a wire value that slipped
      // past `isRobotVendorId`.
      const bad: never = id;
      throw new Error(`Unknown robot program vendor: ${String(bad)}`);
    }
  }
  if (options.axisBased !== undefined) pp.axisBased = options.axisBased;
  return pp;
}
