// plan-659 spike — the WASM asset seam of the demo page (Phase 2).
//
// THE two `?url` imports of this spike, isolated in one file for the same
// reason `kinematic-solver/rv-kinematic-wasm-url.ts` exists: a `?url` import is
// a build-time fact about WHERE a binary lives, and that is a property of the
// tree that owns the entry point — not of the production module that consumes
// the URL.
//
// Concretely here: the production loader lives in the private sibling, but the
// dev server does not serve `/@fs/<private sibling>/node_modules/**` (it
// answers index.html, which reaches WebAssembly.instantiate as `3c 21 44 4f` =
// "<!DO"). Resolved from THIS file the two binaries come out of
// `realvirtual-WebViewer~/node_modules`, which the dev server serves with
// `application/wasm`, verified.
//
// Both packages are OUT-OF-BAND (`npm i --no-save`, exact versions from the
// fixture meta: `@mujoco/mujoco` 3.11.0, `onnxruntime-web` 1.27.0). The `.jsep.`
// variant is NEVER imported — that is the 26.8 MB WebGPU build (M10).

import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

export const MUJOCO_WASM_URL: string = mujocoWasmUrl;
export const ORT_WASM_URL: string = ortWasmUrl;
