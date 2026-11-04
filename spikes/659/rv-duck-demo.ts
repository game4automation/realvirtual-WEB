// plan-659 spike — the browser demo (Phase 2). "Open a link, see the robot walk."
//
// A STANDALONE page on purpose (plan review #8): its own Three.js scene, its
// own GLTFLoader, no viewer, no plugin registration. Two reasons, both measured
// rather than assumed:
//
//  1. `useFeature` is private to `private-plugins.ts`, so a spike cannot hang
//     itself into the feature system without touching core files.
//  2. The destructive bake EATS this asset: loaded through the viewer, the 23
//     named nodes of `rv-duck.glb` are gone (nothing claims them — `rv_joint`
//     is OUR extra, the bake does not know it) and the scene keeps only
//     `rv_duck_scene` and `static`. Mirroring in joint space needs those nodes.
//     Putting the duck into a REAL viewer scene therefore needs claimed drives
//     or a `bakeClaims()` — a Phase-5 decision, not this page's job.
//
// Everything reusable lives elsewhere: the scheduler, the joint mirror and the
// browser loader seams are production code under `@rv-private/mujoco/*`; the
// fixture plumbing is `rv-duck-browser-runtime.ts`. This file is scene, camera,
// loop, UI — and the test API the Playwright smoke drives.

import {
  AmbientLight,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RVMuJoCoJointMirror } from '@rv-private/mujoco/rv-mujoco-joint-mirror';
import {
  RVMuJoCoScheduler,
  type RVMuJoCoPolicyDriver,
} from '@rv-private/mujoco/rv-mujoco-scheduler';
import { percentile } from './microduck-contract';
import { DUCK_GLB_URL, RVDuckBrowserRuntime, loadReference } from './rv-duck-browser-runtime';

// ─── Scene ───────────────────────────────────────────────────────────────────

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;

const scene = new Scene();
scene.background = new Color(0x14171c);
scene.fog = new Fog(0x14171c, 4, 14);

const camera = new PerspectiveCamera(42, 1, 0.01, 100);
camera.position.set(0.55, 0.38, 0.62);

scene.add(new HemisphereLight(0xbcd4ff, 0x1b1e24, 0.85));
scene.add(new AmbientLight(0xffffff, 0.12));
const sun = new DirectionalLight(0xffffff, 1.9);
sun.position.set(1.2, 2.2, 1.0);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 0.05;
sun.shadow.camera.far = 8;
const shadowSpan = 0.9;
sun.shadow.camera.left = -shadowSpan;
sun.shadow.camera.right = shadowSpan;
sun.shadow.camera.top = shadowSpan;
sun.shadow.camera.bottom = -shadowSpan;
scene.add(sun);
scene.add(sun.target);

// The contact plane. MuJoCo's `plane` sits at z = 0; this page's floor sits at
// y = 0 and the two are the SAME plane, because the asset root turns Z-up into
// Y-up (coordinate contract §2.4). The visible mesh is 1 mm below the grid so
// the two do not z-fight.
const floor = new Mesh(
  new PlaneGeometry(40, 40),
  new MeshStandardMaterial({
    color: 0xffffff,
    map: makeGridTexture(),
    roughness: 0.92,
    metalness: 0,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

/**
 * The grid as a TEXTURE, not as line geometry.
 *
 * A `GridHelper` would be the obvious choice and was the first attempt — but
 * its 1-px lines only survived at the horizon, where many of them pile into one
 * band; in the near field, where the duck actually walks, they vanished. A
 * mipmapped texture has no such failure mode, reads cleanly at every distance
 * and costs one draw call less. One tile = 1 m, subdivided into 10 cm cells, so
 * the ~11 cm/s the duck travels is legible even in a still frame.
 */
function makeGridTexture(): CanvasTexture {
  const size = 256; // px per metre
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#23272e';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#333a44';
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const at = Math.round((i * size) / 10) + 0.5;
    ctx.beginPath();
    ctx.moveTo(at, 0);
    ctx.lineTo(at, size);
    ctx.moveTo(0, at);
    ctx.lineTo(size, at);
    ctx.stroke();
  }
  // The metre lines, brighter and wider.
  ctx.strokeStyle = '#49525f';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(40, 40); // the plane is 40 m × 40 m → one tile per metre
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.magFilter = NearestFilter;
  return texture;
}

/** Everything simulated hangs under here, so a reset or a fail-off has exactly
 *  one thing to hide. */
const duckGroup = new Group();
scene.add(duckGroup);

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ─── UI plumbing ─────────────────────────────────────────────────────────────

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const hud = {
  state: el('m-state'),
  policy: el('m-policy'),
  sim: el('m-sim'),
  dist: el('m-dist'),
  height: el('m-height'),
  rtf: el('m-rtf'),
  lat: el('m-lat'),
  frame: el('m-frame'),
  drop: el('m-drop'),
  con: el('m-con'),
  fps: el('m-fps'),
};
const statusText = el('s-text');
const statusDot = el('s-dot');
const statusPanel = el('status');
const btnActivate = el<HTMLButtonElement>('btn-activate');
const btnRun = el<HTMLButtonElement>('btn-run');
const btnReset = el<HTMLButtonElement>('btn-reset');
const btnPush = el<HTMLButtonElement>('btn-push');
const vxInput = el<HTMLInputElement>('vx');
const vxOut = el('vx-out');
const yawInput = el<HTMLInputElement>('yaw');
const yawOut = el('yaw-out');

function setStatus(text: string, kind: 'idle' | 'run' | 'fall' | 'err' = 'idle'): void {
  statusText.innerHTML = text;
  statusDot.className = `dot${kind === 'idle' ? '' : ` ${kind}`}`;
  statusPanel.classList.toggle('error', kind === 'err');
}

// ─── Demo state ──────────────────────────────────────────────────────────────

type DemoStatus = 'booting' | 'ready' | 'loading' | 'running' | 'paused' | 'failed' | 'error';

interface FrameSample {
  busyMs: number;
  frameMs: number;
}

const demo = {
  status: 'booting' as DemoStatus,
  error: null as string | null,
  runtime: null as RVDuckBrowserRuntime | null,
  scheduler: null as RVMuJoCoScheduler | null,
  mirror: null as RVMuJoCoJointMirror | null,
  duckRoot: null as Object3D | null,
  /** Main-thread time the simulation spent since the previous frame (ms). */
  busyAccumMs: 0,
  samples: [] as FrameSample[],
  measureStartWall: 0,
  measureStartSim: 0,
  fpsFrames: 0,
  fpsSince: 0,
  fps: 0,
  injectFailure: false,
  wasmUrls: { mujoco: '', ort: '' },
  loadMs: { glb: 0, libs: 0, world: 0, policies: 0 },
};

const MAX_SAMPLES = 20_000;

// ─── GLB: load it and bind the joints ────────────────────────────────────────

async function loadDuckModel(): Promise<void> {
  const t0 = performance.now();
  const gltf = await new GLTFLoader().loadAsync(DUCK_GLB_URL);
  demo.loadMs.glb = performance.now() - t0;
  const root = gltf.scene;
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  duckGroup.add(root);
  demo.duckRoot = root;
  demo.mirror = RVMuJoCoJointMirror.fromObject3D(root);
  if (demo.mirror.skipped.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[duck] joints skipped:', demo.mirror.skipped);
  }
  if (demo.mirror.joints.length === 0 || !demo.mirror.base) {
    throw new Error('rv-duck.glb carries no rv_joint/rv_free_joint extras — wrong asset?');
  }
}

// ─── Activation: the two WASM payloads, the world and the policies ───────────

/** The driver the scheduler sees. It forwards to the runtime and does two
 *  things of its own: accumulate main-thread busy time, and provide the
 *  deliberate fail-off trap of test 9.5. */
function makeDriver(runtime: RVDuckBrowserRuntime): RVMuJoCoPolicyDriver {
  const timed = <T>(fn: () => T): T => {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      demo.busyAccumMs += performance.now() - t0;
    }
  };
  return {
    get decimation() {
      return runtime.decimation;
    },
    get physicsDt() {
      return runtime.physicsDt;
    },
    get generation() {
      return runtime.generation;
    },
    buildObservation: () => timed(() => runtime.buildObservation()),
    infer: async (obs) => {
      const t0 = performance.now();
      try {
        return await runtime.infer(obs);
      } finally {
        demo.busyAccumMs += performance.now() - t0;
      }
    },
    applyAction: (action) => timed(() => runtime.applyAction(action)),
    step: (steps) =>
      timed(() => {
        if (demo.injectFailure) {
          demo.injectFailure = false;
          throw new Error('injected WASM trap (fail-off test)');
        }
        runtime.step(steps);
      }),
  };
}

let activation: Promise<void> | null = null;

function activate(): Promise<void> {
  if (!activation) activation = doActivate();
  return activation;
}

async function doActivate(): Promise<void> {
  demo.status = 'loading';
  btnActivate.disabled = true;
  try {
    setStatus('loading MuJoCo + ONNX Runtime (WASM)&hellip;');
    const t0 = performance.now();
    // Dynamic import: until this line runs, not one byte of mujoco.wasm or
    // ort-*.wasm has been requested (plan F7 / test 9.4 — the Playwright smoke
    // asserts exactly that against the network log).
    const [loaders, urls] = await Promise.all([
      import('@rv-private/mujoco/mujoco-browser-loaders'),
      import('./duck-wasm-urls'),
    ]);
    loaders.installMuJoCoBrowserLoaders({
      mujocoWasmUrl: urls.MUJOCO_WASM_URL,
      ortWasmUrl: urls.ORT_WASM_URL,
      ortThreads: 1,
    });
    demo.wasmUrls = { mujoco: urls.MUJOCO_WASM_URL, ort: urls.ORT_WASM_URL };
    demo.loadMs.libs = performance.now() - t0;

    setStatus('compiling the MJCF and the policies&hellip;');
    const t1 = performance.now();
    const runtime = await RVDuckBrowserRuntime.create();
    demo.loadMs.world = performance.now() - t1;
    runtime.setCommand(Number(vxInput.value), 0, Number(yawInput.value));
    demo.runtime = runtime;

    demo.scheduler = new RVMuJoCoScheduler(makeDriver(runtime), {
      mode: 'parity',
      maxBacklogSteps: 6,
      onError: (err) => {
        // Fail-off (plan F8): the backend goes dark, the PAGE keeps running.
        demo.status = 'failed';
        demo.error = String(err);
        duckGroup.visible = false;
        setStatus(`backend failed off: <b>${String(err)}</b> &mdash; page still runs`, 'err');
        updateButtons();
      },
    });

    mirrorOnce();
    demo.status = 'running';
    beginMeasurement();
    setStatus('walking', 'run');
  } catch (err) {
    demo.status = 'error';
    demo.error = String(err);
    setStatus(`load failed: <b>${String(err)}</b>`, 'err');
    // eslint-disable-next-line no-console
    console.error('[duck] activation failed', err);
  }
  updateButtons();
}

// ─── Loop ────────────────────────────────────────────────────────────────────

function mirrorOnce(): void {
  const { runtime, mirror } = demo;
  if (!runtime || !mirror) return;
  mirror.apply(runtime.readQpos(), runtime.freeJointQposAdr, runtime.qposAdr);
}

const camTarget = new Vector3();
const camDesired = new Vector3();

function updateCamera(dt: number): void {
  const runtime = demo.runtime;
  if (!runtime) return;
  const [x, y, z] = runtime.basePosition();
  // MuJoCo (x, y, z) → Three.js (x, z, −y): the same −90° X turn the asset root
  // applies, done here for the camera instead of for geometry.
  camTarget.set(x, z, -y);
  camDesired.set(x + 0.45, z + 0.3, -y + 0.55);
  // Critically damped follow, so the duck never leaves the frame but the camera
  // does not jitter with the gait.
  const k = 1 - Math.exp(-dt * 3.5);
  camera.position.lerp(camDesired, k);
  sun.target.position.copy(camTarget);
  camera.lookAt(camTarget);
}

let lastFrame = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);
  const frameMs = now - lastFrame;
  const dt = Math.min(frameMs / 1000, 0.1);
  lastFrame = now;

  if (demo.status === 'running' && demo.scheduler) {
    demo.scheduler.advance(dt);
    mirrorOnce();
  }
  updateCamera(dt);
  renderer.render(scene, camera);

  if (demo.samples.length < MAX_SAMPLES) {
    demo.samples.push({ busyMs: demo.busyAccumMs, frameMs });
  }
  demo.busyAccumMs = 0;

  demo.fpsFrames++;
  if (now - demo.fpsSince > 500) {
    demo.fps = (demo.fpsFrames * 1000) / (now - demo.fpsSince);
    demo.fpsFrames = 0;
    demo.fpsSince = now;
    updateHud();
  }
}

function beginMeasurement(): void {
  demo.samples.length = 0;
  demo.measureStartWall = performance.now();
  demo.measureStartSim = demo.scheduler?.stats().simTimeS ?? 0;
  demo.scheduler?.resetStats();
  demo.measureStartSim = 0;
}

function metrics() {
  const stats = demo.scheduler?.stats();
  const wallS = (performance.now() - demo.measureStartWall) / 1000;
  const simS = (stats?.simTimeS ?? 0) - demo.measureStartSim;
  const lat = stats ? [...stats.latenciesMs] : [];
  const busy = demo.samples.map((s) => s.busyMs);
  const totalBusyMs = busy.reduce((a, b) => a + b, 0);
  const frames = demo.samples.map((s) => s.frameMs);
  return {
    status: demo.status,
    error: demo.error,
    simTimeS: simS,
    wallClockS: wallS,
    realTimeFactor: wallS > 0 ? simS / wallS : 0,
    policySteps: stats?.policySteps ?? 0,
    droppedSimTimeS: stats?.droppedSimTimeS ?? 0,
    policyStalls: stats?.policyStalls ?? 0,
    nonFiniteActions: stats?.nonFiniteActions ?? 0,
    staleResults: stats?.staleResults ?? 0,
    backlogS: stats?.backlogS ?? 0,
    policyLatencyMs: {
      samples: lat.length,
      median: percentile(lat, 0.5),
      p95: percentile(lat, 0.95),
      max: lat.length ? Math.max(...lat) : Number.NaN,
    },
    frameCostMs: {
      samples: busy.length,
      median: percentile(busy, 0.5),
      p95: percentile(busy, 0.95),
      max: busy.length ? Math.max(...busy) : Number.NaN,
    },
    // The plan asks for "p95 < 4 ms per 60-Hz frame". Measuring that against
    // the REAL frames of this run would measure the renderer: a headless
    // SwiftShader frame is ~60 ms, so it carries ~3.6 policy steps instead of
    // the 0.83 a 60-Hz frame carries. The comparable number is therefore the
    // simulation cost per 16.67 ms of SIMULATED time, which is what this is.
    costPerSimSecondMs: simS > 0 ? totalBusyMs / simS : Number.NaN,
    costPer60HzFrameMs: simS > 0 ? totalBusyMs / simS / 60 : Number.NaN,
    totalBusyMs,
    frameIntervalMs: {
      median: percentile(frames, 0.5),
      p95: percentile(frames, 0.95),
    },
    fps: demo.fps,
    loadMs: demo.loadMs,
    wasmUrls: demo.wasmUrls,
    duck: demo.runtime?.state() ?? null,
    mirror: demo.mirror
      ? { joints: demo.mirror.joints.length, skipped: demo.mirror.skipped.length }
      : null,
  };
}

function updateHud(): void {
  const m = metrics();
  const duck = m.duck;
  hud.state.textContent = demo.status;
  hud.policy.textContent = duck ? duck.activePolicy : '–';
  hud.sim.textContent = `${m.simTimeS.toFixed(1)} s`;
  hud.dist.textContent = duck ? `${duck.distanceM.toFixed(3)} m` : '–';
  hud.height.textContent = duck ? `${(duck.baseHeightM * 1000).toFixed(0)} mm` : '–';
  hud.rtf.textContent = m.realTimeFactor ? `${m.realTimeFactor.toFixed(2)} ×` : '–';
  hud.lat.textContent = Number.isFinite(m.policyLatencyMs.p95)
    ? `${m.policyLatencyMs.p95.toFixed(2)} ms`
    : '–';
  hud.frame.textContent = Number.isFinite(m.frameCostMs.p95)
    ? `${m.frameCostMs.p95.toFixed(2)} ms`
    : '–';
  hud.drop.textContent = `${(m.droppedSimTimeS * 1000).toFixed(0)} ms`;
  hud.con.textContent = duck ? String(duck.contacts) : '0';
  hud.fps.textContent = m.fps ? m.fps.toFixed(0) : '–';
  if (demo.status === 'running' && duck) {
    if (duck.fallen) setStatus(`fallen &mdash; <b>${duck.activePolicy}</b> policy recovering`, 'fall');
    else setStatus(`walking &middot; ${duck.fallCount} fall(s), ${duck.recoveries} recovery(ies)`, 'run');
  }
}

function updateButtons(): void {
  const live = demo.status === 'running' || demo.status === 'paused';
  btnRun.disabled = !live;
  btnReset.disabled = !live;
  btnPush.disabled = demo.status !== 'running';
  btnRun.textContent = demo.status === 'running' ? 'Stop' : 'Start';
  btnActivate.disabled = demo.status !== 'ready';
}

// ─── Controls ────────────────────────────────────────────────────────────────

function setVx(vx: number): void {
  vxInput.value = String(vx);
  vxOut.textContent = `${vx.toFixed(2)} m/s`;
  demo.runtime?.setCommand(vx);
}

function setYaw(yaw: number): void {
  yawInput.value = String(yaw);
  yawOut.textContent = `${yaw.toFixed(2)} rad/s`;
  const runtime = demo.runtime;
  if (runtime) runtime.setCommand(Number(vxInput.value), runtime.state().commandVy, yaw);
}

function setVy(vy: number): void {
  demo.runtime?.setCommand(Number(vxInput.value), vy, Number(yawInput.value));
}

function toggleRun(): void {
  if (demo.status === 'running') {
    demo.status = 'paused';
    demo.scheduler?.stop();
    setStatus('paused');
  } else if (demo.status === 'paused') {
    demo.status = 'running';
    demo.scheduler?.clearBacklog();
    demo.scheduler?.start();
    setStatus('walking', 'run');
  }
  updateButtons();
}

function reset(): void {
  demo.runtime?.reset();
  demo.scheduler?.clearBacklog();
  beginMeasurement();
  mirrorOnce();
  updateHud();
}

btnActivate.addEventListener('click', () => void activate());
btnRun.addEventListener('click', toggleRun);
btnReset.addEventListener('click', reset);
btnPush.addEventListener('click', () => demo.runtime?.pushBase(0, 1.0));
vxInput.addEventListener('input', () => setVx(Number(vxInput.value)));
yawInput.addEventListener('input', () => setYaw(Number(yawInput.value)));

const VX_STEP = 0.05;
const YAW_STEP = 0.2;
window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  const key = event.key.toLowerCase();
  const vx = Number(vxInput.value);
  const yaw = Number(yawInput.value);
  switch (key) {
    case 'w': setVx(Math.min(0.6, vx + VX_STEP)); break;
    case 's': setVx(Math.max(-0.4, vx - VX_STEP)); break;
    case 'a': setYaw(Math.min(1, yaw + YAW_STEP)); break;
    case 'd': setYaw(Math.max(-1, yaw - YAW_STEP)); break;
    case 'q': setVy(0.15); break;
    case 'e': setVy(-0.15); break;
    case 'r': reset(); break;
    case ' ': demo.runtime?.pushBase(0, 1.0); event.preventDefault(); break;
    default: return;
  }
});
window.addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'q' || key === 'e') setVy(0);
});

// ─── Parity self-test (browser chain vs the Phase-1 fixtures) ───────────────

/**
 * Feed the Phase-0 reference fixtures through the BROWSER chain
 * (`onnxruntime-web/wasm`) and report the deviation from the Python reference
 * the Node chain matched bit for bit.
 *
 * This is the one question Phase 1 left explicitly open: ORT-Web picks other
 * kernels than ORT-Node, so whether the browser reproduces the same bits is a
 * measurement, not an assumption.
 */
async function parity(): Promise<unknown> {
  const runtime = demo.runtime;
  if (!runtime) throw new Error('activate first');
  const reference = await loadReference();
  const policy = runtime.activePolicy;
  const results: { step: number; obs: number; action: number; ctrl: number }[] = [];
  for (const fixture of reference.fixtures) {
    policy.reset();
    (policy.lastActionView as Float32Array).set(fixture.input.last_action);
    policy.setCommand(fixture.input.command);
    const obs = policy.buildObservation({
      baseAngVel: fixture.input.raw_state.base_ang_vel_gyro,
      baseQuat: fixture.input.raw_state.base_quat_xquat_wxyz,
      jointPos: fixture.input.raw_state.joint_pos,
      jointVel: fixture.input.raw_state.joint_vel,
    });
    const obsDelta = maxAbsDiff(obs, fixture.expected.observation);
    // Stage 2 of test 9.7: feed the PYTHON observation, so an error in the
    // observation cannot hide behind a matching action.
    policy.reset();
    const action = await policy.infer(Float32Array.from(fixture.expected.observation));
    const actionDelta = action ? maxAbsDiff(action, fixture.expected.action) : Number.NaN;
    const ctrlDelta = action
      ? maxAbsDiff(policy.actionToCtrl(action), fixture.expected.ctrl_position_target)
      : Number.NaN;
    results.push({
      step: fixture.control_step,
      obs: obsDelta,
      action: actionDelta,
      ctrl: ctrlDelta,
    });
  }
  // Restore a clean state — the parity run perturbed the live policy.
  runtime.reset();
  reset();
  return {
    fixtures: results.length,
    maxObsDelta: Math.max(...results.map((r) => r.obs)),
    maxActionDelta: Math.max(...results.map((r) => r.action)),
    maxCtrlDelta: Math.max(...results.map((r) => r.ctrl)),
    perFixture: results,
    ortChain: 'onnxruntime-web/wasm 1.27.0',
    nodeChainReference: { obs: 1.192e-7, action: 0 },
  };
}

function maxAbsDiff(actual: ArrayLike<number>, expected: readonly number[]): number {
  let worst = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    if (d > worst) worst = d;
  }
  return worst;
}

// ─── Test API ────────────────────────────────────────────────────────────────

const api = {
  get status() {
    return demo.status;
  },
  get error() {
    return demo.error;
  },
  activate,
  start: () => {
    if (demo.status === 'paused') toggleRun();
  },
  stop: () => {
    if (demo.status === 'running') toggleRun();
  },
  reset,
  setVx,
  setYaw,
  push: (dvy = 1.0) => demo.runtime?.pushBase(0, dvy),
  beginMeasurement,
  metrics,
  parity,
  /** Trip the next physics step on purpose — fail-off test (plan F8 / 9.5). */
  failNextStep: () => {
    demo.injectFailure = true;
  },
  /** Names of the bound joints, for the mirror test. */
  joints: () => demo.mirror?.joints.map((j) => ({ name: j.name, node: j.node.name })) ?? [],
};
(window as unknown as { __rvDuck: typeof api }).__rvDuck = api;

// ─── Boot ────────────────────────────────────────────────────────────────────

requestAnimationFrame(frame);

void (async () => {
  try {
    await loadDuckModel();
    demo.status = 'ready';
    updateButtons();
    setStatus('scene ready &mdash; press <b>Load &amp; run</b>');
    if (new URLSearchParams(location.search).get('autostart') === '1') await activate();
  } catch (err) {
    demo.status = 'error';
    demo.error = String(err);
    setStatus(`scene failed: <b>${String(err)}</b>`, 'err');
    // eslint-disable-next-line no-console
    console.error('[duck] boot failed', err);
  }
})();
