const RV_SPIKE_DIR = require('node:path').resolve(__dirname, '..');
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// spikes/659/rv-microduck-runtime.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// ../realvirtual-WebViewer-Private~/src/mujoco/rv-locomotion-policy.ts
var defaultOrtLibLoader = async () => {
  const mod = await import("onnxruntime-node");
  const ort = mod.default?.InferenceSession ? mod.default : mod;
  return {
    createSession: async (model) => await ort.InferenceSession.create(model, {
      executionProviders: ["cpu"]
    }),
    createFloatTensor: (data, dims) => new ort.Tensor("float32", data, dims)
  };
};
var activeOrtLoader = defaultOrtLibLoader;
function setOrtLibLoader(loader) {
  activeOrtLoader = loader ?? defaultOrtLibLoader;
}
function quatRotateInverse(q, v, out) {
  const w = q[0];
  const x = q[1];
  const y = q[2];
  const z = q[3];
  const vx = v[0];
  const vy = v[1];
  const vz = v[2];
  const s = 2 * w * w - 1;
  const cx = (y * vz - z * vy) * -2 * w;
  const cy = (z * vx - x * vz) * -2 * w;
  const cz = (x * vy - y * vx) * -2 * w;
  const dot2 = (x * vx + y * vy + z * vz) * 2;
  out[0] = Math.fround(vx * s + cx + x * dot2);
  out[1] = Math.fround(vy * s + cy + y * dot2);
  out[2] = Math.fround(vz * s + cz + z * dot2);
  return out;
}
var GRAVITY_DOWN = Object.freeze([0, 0, -1]);
var RVLocomotionPolicy = class _RVLocomotionPolicy {
  ort;
  session;
  config;
  actionSize;
  defaultPose;
  scale;
  obs;
  lastAction;
  action;
  ctrl;
  command;
  gravityScratch = new Float32Array(3);
  inputName;
  outputName;
  disposed = false;
  /** Incremented by `reset()`; a result that carries an older generation is
   *  discarded by the caller (scheduler contract §2.4). */
  generationCounter = 0;
  constructor(ort, session, config) {
    this.ort = ort;
    this.session = session;
    this.config = config;
    this.actionSize = config.jointNames.length;
    if (config.defaultJointPos.length !== this.actionSize) {
      throw new RangeError(
        `defaultJointPos has ${config.defaultJointPos.length} entries, expected ${this.actionSize}`
      );
    }
    this.defaultPose = Float32Array.from(config.defaultJointPos);
    this.scale = typeof config.actionScale === "number" ? new Float32Array(this.actionSize).fill(config.actionScale) : Float32Array.from(config.actionScale);
    if (this.scale.length !== this.actionSize) {
      throw new RangeError(`actionScale has ${this.scale.length} entries, expected ${this.actionSize}`);
    }
    this.obs = new Float32Array(config.observationSize);
    this.lastAction = new Float32Array(this.actionSize);
    this.action = new Float32Array(this.actionSize);
    this.ctrl = new Float64Array(this.actionSize);
    this.command = new Float32Array(config.commandSize);
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
    const assembled = config.observationLayout.reduce(
      (sum, segment) => sum + this.segmentLength(segment),
      0
    );
    if (assembled !== config.observationSize) {
      throw new RangeError(
        `observationLayout sums to ${assembled}, observationSize says ${config.observationSize}`
      );
    }
  }
  /** Load an ONNX policy from bytes or a path. */
  static async load(model, config) {
    const ort = await activeOrtLoader();
    const session = await ort.createSession(model);
    return new _RVLocomotionPolicy(ort, session, config);
  }
  /** Number of joints the policy drives. */
  get numJoints() {
    return this.actionSize;
  }
  /** Policy rate in Hz (`1 / (physicsDt × decimation)`). */
  get rateHz() {
    return 1 / (this.config.physicsDt * this.config.decimation);
  }
  /** Physics steps per policy step. */
  get decimation() {
    return this.config.decimation;
  }
  /** Current generation — bumped by {@link reset}. */
  get generation() {
    return this.generationCounter;
  }
  /** The action of the previous policy step (part of the observation). */
  get lastActionView() {
    return this.lastAction;
  }
  /** Write the command vector (e.g. `command[0] = vx`). Values are copied. */
  setCommand(command) {
    const n = Math.min(command.length, this.command.length);
    for (let i = 0; i < n; i++) this.command[i] = command[i];
  }
  /** Set one command slot. */
  setCommandAt(index, value) {
    if (index < 0 || index >= this.command.length) {
      throw new RangeError(`command index ${index} out of range (${this.command.length})`);
    }
    this.command[index] = value;
  }
  /** Drop the carried `lastAction` and bump the generation. */
  reset() {
    this.lastAction.fill(0);
    this.generationCounter++;
  }
  /**
   * Assemble the observation vector from raw state.
   *
   * No scaling and no clipping: the Microduck contract was MEASURED in Phase 0
   * to concatenate raw values. A policy that needs scaling gets it as config,
   * never silently here.
   *
   * The returned array is REUSED on the next call — copy it if it must outlive
   * the call (the inference below copies into the tensor).
   */
  buildObservation(state) {
    const obs = this.obs;
    let at = 0;
    for (const segment of this.config.observationLayout) {
      switch (segment) {
        case "base_ang_vel":
          for (let i = 0; i < 3; i++) obs[at++] = Math.fround(state.baseAngVel[i]);
          break;
        case "projected_gravity": {
          const g = quatRotateInverse(state.baseQuat, GRAVITY_DOWN, this.gravityScratch);
          for (let i = 0; i < 3; i++) obs[at++] = g[i];
          break;
        }
        case "joint_pos":
          for (let i = 0; i < this.actionSize; i++) {
            obs[at++] = Math.fround(Math.fround(state.jointPos[i]) - this.defaultPose[i]);
          }
          break;
        case "joint_vel":
          for (let i = 0; i < this.actionSize; i++) obs[at++] = Math.fround(state.jointVel[i]);
          break;
        case "last_action":
          for (let i = 0; i < this.actionSize; i++) obs[at++] = this.lastAction[i];
          break;
        case "command":
          for (let i = 0; i < this.command.length; i++) obs[at++] = this.command[i];
          break;
      }
    }
    return obs;
  }
  /**
   * Run one inference. Returns the action (reused array) or `null` when the
   * output is not finite — a non-finite action is NEVER adopted as
   * `lastAction` and never reaches `ctrl` (finding M8).
   */
  async infer(observation) {
    this.assertLive();
    if (observation.length !== this.config.observationSize) {
      throw new RangeError(
        `observation has ${observation.length} entries, expected ${this.config.observationSize}`
      );
    }
    const tensor = this.ort.createFloatTensor(observation, [1, observation.length]);
    const result = await this.session.run({ [this.inputName]: tensor });
    const out = result[this.outputName];
    if (!out || out.data.length < this.actionSize) {
      throw new Error(`policy output '${this.outputName}' missing or too short`);
    }
    for (let i = 0; i < this.actionSize; i++) {
      const v = out.data[i];
      if (!Number.isFinite(v)) return null;
      this.action[i] = v;
    }
    this.lastAction.set(this.action);
    return this.action;
  }
  /** Map an action to actuator position targets:
   *  `ctrl = defaultJointPos + action × actionScale`. Reused array. */
  actionToCtrl(action) {
    for (let i = 0; i < this.actionSize; i++) {
      this.ctrl[i] = this.defaultPose[i] + action[i] * this.scale[i];
    }
    return this.ctrl;
  }
  /** Nominal joint pose (also the initial `ctrl`). */
  get defaultPoseView() {
    return this.defaultPose;
  }
  /** Release the ORT session. Idempotent. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.session.release?.();
  }
  segmentLength(segment) {
    switch (segment) {
      case "base_ang_vel":
      case "projected_gravity":
        return 3;
      case "command":
        return this.config.commandSize;
      default:
        return this.config.jointNames.length;
    }
  }
  assertLive() {
    if (this.disposed) throw new Error("RVLocomotionPolicy is disposed");
  }
};

// ../realvirtual-WebViewer-Private~/src/mujoco/mujoco-lib-loader.ts
var MUJOCO_MJS_URL = "/node_modules/@mujoco/mujoco/mujoco.js";
var defaultMuJoCoLibLoader = async () => {
  let factory = null;
  try {
    factory = (await import("@mujoco/mujoco")).default;
  } catch {
  }
  if (!factory) {
    const mod = await import(
      /* @vite-ignore */
      MUJOCO_MJS_URL
    );
    factory = mod.default;
  }
  return factory();
};
var activeLoader = defaultMuJoCoLibLoader;
var cachedLib = null;
function loadMuJoCo() {
  if (!cachedLib) {
    const attempt = activeLoader().catch((err) => {
      if (cachedLib === attempt) cachedLib = null;
      throw err;
    });
    cachedLib = attempt;
  }
  return cachedLib;
}

// ../realvirtual-WebViewer-Private~/src/mujoco/rv-mujoco-world.ts
var OBJECT_ENUM_NAME = {
  body: "mjOBJ_BODY",
  joint: "mjOBJ_JOINT",
  sensor: "mjOBJ_SENSOR",
  actuator: "mjOBJ_ACTUATOR",
  geom: "mjOBJ_GEOM",
  site: "mjOBJ_SITE"
};
var RVMuJoCoWorld = class _RVMuJoCoWorld {
  lib;
  model;
  data;
  disposed = false;
  /** Scratch targets so `read*()` allocates nothing in a hot loop. */
  qposScratch;
  qvelScratch;
  ctrlScratch;
  actuatorForceScratch;
  quatScratch = new Float64Array(4);
  posScratch = new Float64Array(3);
  constructor(lib, model, data) {
    this.lib = lib;
    this.model = model;
    this.data = data;
    this.qposScratch = new Float64Array(model.nq);
    this.qvelScratch = new Float64Array(model.nv);
    this.ctrlScratch = new Float64Array(model.nu);
    this.actuatorForceScratch = new Float64Array(model.nu);
  }
  /**
   * Compile `xml` (an MJCF document) and create its data.
   *
   * `files` are placed into the VFS first, so `<mesh file="leg.stl"/>` resolves
   * without touching a real file system — the same path a browser takes when it
   * derives the collision meshes from an already-loaded GLB (finding M4).
   *
   * Rejects when the library is unavailable or the model does not compile; no
   * handle leaks on either path.
   */
  static async load(xml, files = []) {
    const lib = await loadMuJoCo();
    const vfs = new lib.MjVFS();
    let model = null;
    let data = null;
    try {
      for (const file of files) vfs.addBuffer(file.name, file.data);
      const xmlName = "rv-mujoco-world.xml";
      vfs.addBuffer(xmlName, new TextEncoder().encode(xml));
      model = lib.MjModel.from_xml_path(xmlName, vfs);
      data = new lib.MjData(model);
      const world = new _RVMuJoCoWorld(lib, model, data);
      model = null;
      data = null;
      return world;
    } finally {
      data?.delete();
      model?.delete();
      vfs.delete();
    }
  }
  /** Degrees of freedom in position space. */
  get nq() {
    this.assertLive();
    return this.model.nq;
  }
  /** Degrees of freedom in velocity space. */
  get nv() {
    this.assertLive();
    return this.model.nv;
  }
  /** Number of actuators. */
  get nu() {
    this.assertLive();
    return this.model.nu;
  }
  /** Number of bodies (world body included). */
  get nbody() {
    this.assertLive();
    return this.model.nbody;
  }
  /** Physics timestep in seconds, as compiled from the MJCF `<option>`. */
  get timestep() {
    this.assertLive();
    return this.model.opt.timestep;
  }
  /** Simulation time in seconds. */
  get time() {
    this.assertLive();
    return this.data.time;
  }
  /** True once {@link dispose} ran. */
  get isDisposed() {
    return this.disposed;
  }
  /** Advance the simulation by `steps` physics steps (default 1). */
  step(steps = 1) {
    this.assertLive();
    for (let i = 0; i < steps; i++) this.lib.mj_step(this.model, this.data);
  }
  /** Recompute all derived quantities (poses, sensors) without integrating —
   *  needed after writing `qpos`/`qvel` so the first observation is valid. */
  forward() {
    this.assertLive();
    this.lib.mj_forward(this.model, this.data);
  }
  /** Reset to the model's default state (`mj_resetData`). */
  reset() {
    this.assertLive();
    this.lib.mj_resetData(this.model, this.data);
  }
  /** Resolve a named object to its id, or `-1` when unknown. */
  idOf(kind, name) {
    this.assertLive();
    const entry = this.lib.mjtObj[OBJECT_ENUM_NAME[kind]];
    if (!entry) return -1;
    return this.lib.mj_name2id(this.model, entry.value, name);
  }
  /**
   * qpos index of the joint each actuator drives, in actuator order.
   *
   * This is the ONLY correct way to map a policy's joint vector onto the state:
   * the policy's joint order is the MJCF `<actuator>` order, and `qpos` is laid
   * out by joint, with a free joint eating 7 entries up front. Computed from
   * `actuator_trnid` (row-major, 2 per actuator) → `jnt_qposadr`.
   */
  actuatorQposAdr() {
    this.assertLive();
    const trnid = this.model.actuator_trnid;
    const qposadr = this.model.jnt_qposadr;
    const out = new Int32Array(this.model.nu);
    for (let i = 0; i < out.length; i++) out[i] = qposadr[trnid[i * 2]];
    return out;
  }
  /** qvel/dof index of the joint each actuator drives, in actuator order. */
  actuatorDofAdr() {
    this.assertLive();
    const trnid = this.model.actuator_trnid;
    const dofadr = this.model.jnt_dofadr;
    const out = new Int32Array(this.model.nu);
    for (let i = 0; i < out.length; i++) out[i] = dofadr[trnid[i * 2]];
    return out;
  }
  /** `[address, count]` of a sensor inside `sensordata`, or `null` when the
   *  sensor does not exist. */
  sensorRange(name) {
    const id = this.idOf("sensor", name);
    if (id < 0) return null;
    return { adr: this.model.sensor_adr[id], dim: this.model.sensor_dim[id] };
  }
  /** Write the actuator command vector. Values are clamped by MuJoCo itself
   *  (`ctrlrange`); non-finite values are REJECTED here so a bad policy output
   *  can never reach the solver (finding M8). Returns false when rejected. */
  setCtrl(ctrl) {
    this.assertLive();
    const nu = this.model.nu;
    if (ctrl.length < nu) {
      throw new RangeError(`setCtrl expects ${nu} values, got ${ctrl.length}`);
    }
    for (let i = 0; i < nu; i++) {
      if (!Number.isFinite(ctrl[i])) return false;
    }
    const view = this.data.ctrl;
    for (let i = 0; i < nu; i++) view[i] = ctrl[i];
    return true;
  }
  /** Copy `qpos` into `out` (allocated on first use, reused afterwards). */
  readQpos(out) {
    this.assertLive();
    return copyOut(this.data.qpos, this.model.nq, out ?? this.qposScratch);
  }
  /** Copy `qvel` into `out`. */
  readQvel(out) {
    this.assertLive();
    return copyOut(this.data.qvel, this.model.nv, out ?? this.qvelScratch);
  }
  /** Copy the current actuator command vector. */
  readCtrl(out) {
    this.assertLive();
    return copyOut(this.data.ctrl, this.model.nu, out ?? this.ctrlScratch);
  }
  /** Copy the generalized force each actuator produced in the last step (Nm/N). */
  readActuatorForce(out) {
    this.assertLive();
    return copyOut(this.data.actuator_force, this.model.nu, out ?? this.actuatorForceScratch);
  }
  /** World orientation of body `bodyId` as `[w, x, y, z]` (MuJoCo order). */
  readXquat(bodyId, out) {
    this.assertLive();
    const target = out ?? this.quatScratch;
    const view = this.data.xquat;
    const base = bodyId * 4;
    for (let i = 0; i < 4; i++) target[i] = view[base + i];
    return target;
  }
  /** World position of body `bodyId` as `[x, y, z]`. */
  readXpos(bodyId, out) {
    this.assertLive();
    const target = out ?? this.posScratch;
    const view = this.data.xpos;
    const base = bodyId * 3;
    for (let i = 0; i < 3; i++) target[i] = view[base + i];
    return target;
  }
  /** Copy `dim` sensor values starting at `adr` (see {@link sensorRange}). */
  readSensor(adr, dim, out) {
    this.assertLive();
    const target = out ?? new Float64Array(dim);
    const view = this.data.sensordata;
    for (let i = 0; i < dim; i++) target[i] = view[adr + i];
    return target;
  }
  /** Write a slice of `qpos` (e.g. the free-joint pose). Call {@link forward}
   *  afterwards before reading derived quantities. */
  writeQpos(offset, values) {
    this.assertLive();
    const view = this.data.qpos;
    for (let i = 0; i < values.length; i++) view[offset + i] = values[i];
  }
  /** Write a slice of `qvel`. */
  writeQvel(offset, values) {
    this.assertLive();
    const view = this.data.qvel;
    for (let i = 0; i < values.length; i++) view[offset + i] = values[i];
  }
  /** Number of active contacts after the last collision pass (`data.ncon`). */
  contactCount() {
    this.assertLive();
    return this.data.ncon;
  }
  /**
   * Snapshot of the current contact list.
   *
   * `data.contact` is a COPY in Embind, and both the vector and every element
   * read from it are handles — all of them are deleted here before returning,
   * so the caller receives plain objects and can never leak.
   */
  readContacts() {
    this.assertLive();
    const vec = this.data.contact;
    const out = [];
    try {
      const count = vec.size();
      for (let i = 0; i < count; i++) {
        const contact = vec.get(i);
        if (!contact) continue;
        try {
          out.push({
            dist: contact.dist,
            dim: contact.dim,
            geom1: contact.geom[0],
            geom2: contact.geom[1],
            pos: [contact.pos[0], contact.pos[1], contact.pos[2]]
          });
        } finally {
          contact.delete();
        }
      }
    } finally {
      vec.delete();
    }
    return out;
  }
  /** Release model and data. Idempotent — safe in a `finally`, and a second
   *  call is a no-op rather than an Embind double-delete. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.data.delete();
    this.model.delete();
  }
  assertLive() {
    if (this.disposed) throw new Error("RVMuJoCoWorld is disposed");
  }
};
function copyOut(view, count, target) {
  for (let i = 0; i < count; i++) target[i] = view[i];
  return target;
}

// spikes/659/rv-microduck-runtime.ts
var FIXTURE_DIR = (0, import_node_path.resolve)(RV_SPIKE_DIR, "fixtures/microduck");
var TRUNK_BODY = "trunk_base";
var TRUNK_FREEJOINT = "trunk_base_freejoint";
var GYRO_SENSOR = "imu_ang_vel";
var FALL_GZ_THRESHOLD = -0.5;
var FALL_HEIGHT_THRESHOLD = 0.02;
var FALL_DEBOUNCE_S = 0.2;
function loadReference() {
  return JSON.parse(
    (0, import_node_fs.readFileSync)((0, import_node_path.resolve)(FIXTURE_DIR, "reference/microduck-reference-fixtures.json"), "utf8")
  );
}
async function loadMicroduckWorld() {
  const xmlPath = (0, import_node_path.resolve)(FIXTURE_DIR, "mjcf/prepared-scene.xml");
  const xml = (0, import_node_fs.readFileSync)(xmlPath, "utf8");
  const meshNames = [...xml.matchAll(/<mesh[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]);
  const files = meshNames.map((name) => ({
    name,
    data: new Uint8Array((0, import_node_fs.readFileSync)((0, import_node_path.resolve)(FIXTURE_DIR, "mjcf/assets", name)))
  }));
  return RVMuJoCoWorld.load(xml, files);
}
function policyConfigFromContract(contract) {
  return {
    jointNames: contract.joint_names,
    defaultJointPos: contract.default_pose,
    actionScale: contract.action_scale,
    decimation: contract.decimation,
    physicsDt: contract.timestep,
    observationSize: contract.obs_size,
    commandSize: contract.command_size,
    observationLayout: contract.observation_layout.map(segmentOf)
  };
}
function segmentOf(layoutEntry) {
  const name = layoutEntry.split("[")[0].trim();
  switch (name) {
    case "base_ang_vel":
    case "projected_gravity":
    case "joint_pos":
    case "joint_vel":
    case "command":
      return name;
    case "actions":
    case "last_action":
      return "last_action";
    default:
      throw new Error(`unknown observation segment '${layoutEntry}'`);
  }
}
async function loadMicroduckPolicy(kind, contract) {
  const file = kind === "walking" ? "BEST_alpha_walking.onnx" : "BEST_alpha_stand.onnx";
  const bytes = new Uint8Array((0, import_node_fs.readFileSync)((0, import_node_path.resolve)(FIXTURE_DIR, "policies", file)));
  return RVLocomotionPolicy.load(bytes, policyConfigFromContract(contract));
}
var RVMicroduckRuntime = class _RVMicroduckRuntime {
  world;
  contract;
  /** The active policy. Swappable via {@link usePolicy} — walking and stand
   *  share one tensor contract (Phase 0), so recovery is a session swap. */
  policy;
  trunkBodyId;
  freeJointQposAdr;
  gyro;
  qposAdr;
  dofAdr;
  jointPos;
  jointVel;
  quat = new Float64Array(4);
  angVel = new Float64Array(3);
  qposScratch;
  qvelScratch;
  gravityScratch = new Float32Array(3);
  disposed = false;
  constructor(world, policy, contract) {
    this.world = world;
    this.policy = policy;
    this.contract = contract;
    this.trunkBodyId = world.idOf("body", TRUNK_BODY);
    if (this.trunkBodyId < 0) throw new Error(`body '${TRUNK_BODY}' not found`);
    if (world.idOf("joint", TRUNK_FREEJOINT) < 0) {
      throw new Error(`joint '${TRUNK_FREEJOINT}' not found`);
    }
    const gyro = world.sensorRange(GYRO_SENSOR);
    if (!gyro) throw new Error(`sensor '${GYRO_SENSOR}' not found`);
    this.gyro = gyro;
    this.qposAdr = world.actuatorQposAdr();
    this.dofAdr = world.actuatorDofAdr();
    this.freeJointQposAdr = freeJointQposAdr(world);
    this.jointPos = new Float64Array(world.nu);
    this.jointVel = new Float64Array(world.nu);
    this.qposScratch = new Float64Array(world.nq);
    this.qvelScratch = new Float64Array(world.nv);
  }
  /** Load world + policy + runtime in one call. */
  static async create(kind = "walking") {
    const reference = loadReference();
    const contract = reference.meta.contract;
    const world = await loadMicroduckWorld();
    try {
      const policy = await loadMicroduckPolicy(kind, contract);
      return new _RVMicroduckRuntime(world, policy, contract);
    } catch (err) {
      world.dispose();
      throw err;
    }
  }
  /**
   * Put the duck into the Phase-0 start state: base at `(0, 0, init_base_z)`,
   * identity orientation, joints and `ctrl` on the default pose, then
   * `mj_forward` so the first observation reads valid sensors.
   */
  initStartState() {
    this.world.reset();
    const a = this.freeJointQposAdr;
    this.world.writeQpos(a, [0, 0, this.contract.init_base_z_m, 1, 0, 0, 0]);
    const pose = this.contract.default_pose;
    for (let i = 0; i < this.qposAdr.length; i++) {
      this.world.writeQpos(this.qposAdr[i], [pose[i]]);
    }
    this.world.setCtrl(Float64Array.from(pose));
    this.policy.reset();
    this.world.forward();
  }
  /** Base position `[x, y, z]` read from the free joint's qpos slot. */
  basePosition() {
    const qpos = this.world.readQpos(this.qposScratch);
    const a = this.freeJointQposAdr;
    return [qpos[a], qpos[a + 1], qpos[a + 2]];
  }
  /** Projected gravity z in the trunk frame — the fall indicator (M8). */
  projectedGravityZ() {
    const quat = this.world.readXquat(this.trunkBodyId, this.quat);
    const g = quatRotateInverse(quat, [0, 0, -1], this.gravityScratch);
    return g[2];
  }
  /** Assemble the observation from the live world state. */
  buildObservation() {
    const qpos = this.world.readQpos(this.qposScratch);
    const qvel = this.world.readQvel(this.qvelScratch);
    for (let i = 0; i < this.qposAdr.length; i++) {
      this.jointPos[i] = qpos[this.qposAdr[i]];
      this.jointVel[i] = qvel[this.dofAdr[i]];
    }
    return this.policy.buildObservation({
      baseAngVel: this.world.readSensor(this.gyro.adr, 3, this.angVel),
      baseQuat: this.world.readXquat(this.trunkBodyId, this.quat),
      jointPos: this.jointPos,
      jointVel: this.jointVel
    });
  }
  /**
   * One control step in `parity` mode: observation → AWAITED inference →
   * `ctrl` → `decimation` physics steps.
   *
   * A non-finite action is dropped: `ctrl` keeps its previous target and the
   * physics steps still run (finding M8). Returns the inference latency in ms
   * and whether the action was adopted.
   */
  async controlStep() {
    const obs = this.buildObservation();
    const t0 = performance.now();
    const action = await this.policy.infer(obs);
    const latencyMs = performance.now() - t0;
    let actionAccepted = false;
    if (action) {
      actionAccepted = this.world.setCtrl(this.policy.actionToCtrl(action));
    }
    this.world.step(this.contract.decimation);
    return { latencyMs, actionAccepted };
  }
  /**
   * Run `controlSteps` control steps from the current state, tracking distance,
   * base height, the debounced fall criterion and the cost split.
   */
  async run(controlSteps, options = {}) {
    const trackLatency = options.trackLatency ?? true;
    const dtControl = this.contract.timestep * this.contract.decimation;
    const [startX, startY] = this.basePosition();
    let minHeight = this.basePosition()[2];
    let fallAt = null;
    let fallSince = null;
    const latencies = [];
    let physicsWall = 0;
    const wall0 = performance.now();
    for (let k = 0; k < controlSteps; k++) {
      const obs = this.buildObservation();
      const t0 = performance.now();
      const action = await this.policy.infer(obs);
      const t1 = performance.now();
      if (trackLatency) latencies.push(t1 - t0);
      if (action) this.world.setCtrl(this.policy.actionToCtrl(action));
      this.world.step(this.contract.decimation);
      physicsWall += performance.now() - t1;
      const [, , z] = this.basePosition();
      if (z < minHeight) minHeight = z;
      const down = this.projectedGravityZ() > FALL_GZ_THRESHOLD || z < FALL_HEIGHT_THRESHOLD;
      const simTime = (k + 1) * dtControl;
      if (down) {
        if (fallSince === null) fallSince = simTime;
        else if (fallAt === null && simTime - fallSince >= FALL_DEBOUNCE_S) fallAt = fallSince;
      } else {
        fallSince = null;
      }
    }
    const wallClockS = (performance.now() - wall0) / 1e3;
    const [endX, endY, endZ] = this.basePosition();
    const qpos = this.world.readQpos(this.qposScratch);
    const qvel = this.world.readQvel(this.qvelScratch);
    const simTimeS = controlSteps * dtControl;
    return {
      controlSteps,
      simTimeS,
      baseHeightEndM: endZ,
      baseHeightMinM: minHeight,
      distanceXyM: Math.hypot(endX - startX, endY - startY),
      displacementXM: endX - startX,
      meanSpeedXMps: (endX - startX) / simTimeS,
      fallen: fallAt !== null,
      fallAtSimTimeS: fallAt,
      finite: allFinite(qpos) && allFinite(qvel),
      wallClockS,
      policyLatenciesMs: latencies,
      physicsWallS: physicsWall / 1e3,
      contactsAtEnd: this.world.contactCount()
    };
  }
  /** Commanded forward velocity in m/s (`command[0]`, the twist x slot). */
  setForwardVelocity(vx) {
    this.policy.setCommandAt(0, vx);
  }
  /**
   * Swap the active policy (walking ↔ stand). The caller keeps ownership of the
   * previous policy; `lastAction` of the new one is NOT reset, because the
   * observation the recovery policy sees must continue the fall, not pretend a
   * fresh episode.
   */
  usePolicy(policy) {
    this.policy = policy;
  }
  /** Add a velocity impulse to the base (m/s), the push of test 9.9. The free
   *  joint's linear dofs are the first three entries of `qvel`. */
  pushBase(dvx, dvy, dvz = 0) {
    const qvel = this.world.readQvel(this.qvelScratch);
    this.world.writeQvel(0, [qvel[0] + dvx, qvel[1] + dvy, qvel[2] + dvz]);
  }
  /** Release world and session. Idempotent. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.policy.dispose();
    } finally {
      this.world.dispose();
    }
  }
};
function freeJointQposAdr(world) {
  const adrs = Array.from(world.actuatorQposAdr());
  const min = Math.min(...adrs);
  if (min < 7) {
    throw new Error(`unexpected qpos layout: actuated joint at index ${min}, expected >= 7`);
  }
  return 0;
}
function allFinite(values) {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

// spikes/659/scaling/worker.ts
function parseArgs() {
  const get = (k, d) => {
    const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  return {
    episodes: Number(get("episodes", "32")),
    stepsPerEpisode: Number(get("steps", "1500")),
    vx: Number(get("vx", "0.25")),
    pinThreads: get("pin", "1") === "1",
    warmupSteps: Number(get("warmup", "300")),
    trackLatency: get("latency", "0") === "1",
    id: Number(get("id", "0"))
  };
}
function pinOrtToOneThread() {
  setOrtLibLoader(async () => {
    const mod = await import("onnxruntime-node");
    const ort = mod.default?.InferenceSession ? mod.default : mod;
    return {
      createSession: async (model) => await ort.InferenceSession.create(model, {
        executionProviders: ["cpu"],
        intraOpNumThreads: 1,
        interOpNumThreads: 1
      }),
      createFloatTensor: (data, dims) => new ort.Tensor("float32", data, dims)
    };
  });
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function waitForGo() {
  return new Promise((resolve2) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve2());
  });
}
async function main() {
  const args = parseArgs();
  if (args.pinThreads) pinOrtToOneThread();
  const t0 = performance.now();
  const rt = await RVMicroduckRuntime.create("walking");
  const loadMs = performance.now() - t0;
  try {
    rt.setForwardVelocity(args.vx);
    rt.initStartState();
    if (args.warmupSteps > 0) await rt.run(args.warmupSteps, { trackLatency: false });
    const warmMs = performance.now() - t0 - loadMs;
    emit({ ev: "ready", id: args.id, loadMs, warmMs });
    await waitForGo();
    const dtControl = rt.contract.timestep * rt.contract.decimation;
    let simSeconds = 0;
    let wallS = 0;
    let physicsWallS = 0;
    let falls = 0;
    const displacements = [];
    const latencies = [];
    const wall0 = performance.now();
    for (let e = 0; e < args.episodes; e++) {
      rt.initStartState();
      rt.setForwardVelocity(args.vx);
      const s = await rt.run(args.stepsPerEpisode, { trackLatency: args.trackLatency });
      simSeconds += s.simTimeS;
      wallS += s.wallClockS;
      physicsWallS += s.physicsWallS;
      if (s.fallen) falls++;
      displacements.push(s.displacementXM);
      if (args.trackLatency) for (const l of s.policyLatenciesMs) latencies.push(l);
    }
    const windowS = (performance.now() - wall0) / 1e3;
    emit({
      ev: "done",
      id: args.id,
      episodes: args.episodes,
      stepsPerEpisode: args.stepsPerEpisode,
      controlSteps: args.episodes * args.stepsPerEpisode,
      dtControl,
      simSeconds,
      // Self-measured: sum of the in-loop wall clocks (excludes the per-episode
      // reset), and the whole barrier-to-finish window (includes resets).
      loopWallS: wallS,
      windowS,
      physicsWallS,
      selfThroughput: simSeconds / windowS,
      falls,
      displacementXFirst: displacements[0],
      displacementXAllEqual: displacements.every((d) => d === displacements[0]),
      latencyMedianMs: args.trackLatency ? median(latencies) : null,
      latencyP95Ms: args.trackLatency ? percentile(latencies, 95) : null,
      latencyCount: latencies.length
    });
  } finally {
    await rt.dispose();
  }
}
function median(xs) {
  return percentile(xs, 50);
}
function percentile(xs, p) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1));
  return s[i];
}
main().then(
  () => process.exit(0),
  (err) => {
    emit({ ev: "error", message: String(err?.stack ?? err) });
    process.exit(1);
  }
);
