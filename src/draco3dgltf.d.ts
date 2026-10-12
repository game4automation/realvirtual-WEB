// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `draco3dgltf` ships no type declarations. Node-side tooling
 * (`scripts/perf-extract-robot-asset.mjs`, `scripts/compress-glb.mjs`) is plain
 * `.mjs` and never sees the compiler, but the plan-492 asset test is TypeScript
 * and needs the two factory functions `@gltf-transform/core` asks for.
 *
 * The modules themselves are opaque WASM wrappers — `unknown` is the honest
 * type; `registerDependencies()` takes them as-is.
 */
declare module 'draco3dgltf' {
  export function createDecoderModule(config?: object): Promise<unknown>;
  export function createEncoderModule(config?: object): Promise<unknown>;
  const draco3d: {
    createDecoderModule: typeof createDecoderModule;
    createEncoderModule: typeof createEncoderModule;
  };
  export default draco3d;
}
