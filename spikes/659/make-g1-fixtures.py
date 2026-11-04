#!/usr/bin/env python3
"""plan-659 Phase 0 - license/asset gate for the Unitree G1 policy pair.

Candidate 1 of the plan: unitreerobotics/unitree_rl_gym @ 276801e4,
deploy/pre_train/g1/motion.pt (TorchScript, NOT ONNX) against
resources/robots/g1_description/scene.xml -> g1_12dof.xml.

Does three things:
  1. exports motion.pt to ONNX and checks the exported graph against the
     TorchScript module (the plan's "ONNX available or reproducible export"),
  2. reads the resulting tensor contract (shapes in/out),
  3. reproduces deploy/deploy_mujoco/deploy_mujoco.py and dumps the raw-state
     -> observation -> action fixtures plus a 60 s stability run.

The G1 mesh set is 54 MB and is deliberately NOT checked into the spike (see
plan-659 N7). Point --meshroot at a directory holding g1_12dof.xml, scene.xml
and meshes/ fetched at the revision recorded in g1-asset-manifest.json.

Run:  <venv>/python make-g1-fixtures.py --meshroot <dir>
"""
import argparse
import json
import os
import platform

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures", "g1")
OUT = os.path.join(FIX, "reference")
POLICY_PT = os.path.join(FIX, "policy", "motion.pt")
POLICY_ONNX = os.path.join(FIX, "policy", "motion.onnx")

# deploy/deploy_mujoco/configs/g1.yaml @ 276801e4
SIMULATION_DT = 0.002
CONTROL_DECIMATION = 10
KPS = np.array([100, 100, 100, 150, 40, 40, 100, 100, 100, 150, 40, 40], dtype=np.float32)
KDS = np.array([2, 2, 2, 4, 2, 2, 2, 2, 2, 4, 2, 2], dtype=np.float32)
DEFAULT_ANGLES = np.array([-0.1, 0.0, 0.0, 0.3, -0.2, 0.0,
                           -0.1, 0.0, 0.0, 0.3, -0.2, 0.0], dtype=np.float32)
ANG_VEL_SCALE = 0.25
DOF_POS_SCALE = 1.0
DOF_VEL_SCALE = 0.05
ACTION_SCALE = 0.25
CMD_SCALE = np.array([2.0, 2.0, 0.25], dtype=np.float32)
NUM_ACTIONS = 12
NUM_OBS = 47
GAIT_PERIOD = 0.8
JOINT_NAMES = [
    "left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint",
    "left_knee_joint", "left_ankle_pitch_joint", "left_ankle_roll_joint",
    "right_hip_pitch_joint", "right_hip_roll_joint", "right_hip_yaw_joint",
    "right_knee_joint", "right_ankle_pitch_joint", "right_ankle_roll_joint",
]


def get_gravity_orientation(q):
    """deploy_mujoco.py get_gravity_orientation, quaternion order w,x,y,z."""
    qw, qx, qy, qz = (float(q[0]), float(q[1]), float(q[2]), float(q[3]))
    g = np.zeros(3, dtype=np.float32)
    g[0] = 2 * (-qz * qx + qw * qy)
    g[1] = -2 * (qz * qy + qw * qx)
    g[2] = 1 - 2 * (qw * qw + qz * qz)
    return g


def pd_control(target_q, q, kp, target_dq, dq, kd):
    return (target_q - q) * kp + (target_dq - dq) * kd


HIDDEN_SIZE = 64
LSTM_LAYERS = 1


def export_onnx():
    """TorchScript -> ONNX, then verify the export against the original.

    motion.pt is NOT a plain MLP: it is a STATEFUL recurrent module
    (memory = nn.LSTM(47 -> 64, 1 layer), actor = MLP 64->32->12) whose
    hidden_state / cell_state are module buffers mutated in place on every
    forward (torch.copy_). A naive torch.onnx.export of it therefore bakes
    the export-time buffer in and does not thread state across calls, so the
    exported graph does NOT reproduce the module. The export below wraps it
    into the stateless form (obs, h_in, c_in) -> (actions, h_out, c_out) and
    the caller threads the state, which is what any TS/ORT port must do too.
    """
    import torch
    module = torch.jit.load(POLICY_PT)
    module.eval()

    # The scripted LSTM exposes its call as forward__0 (see module.code), so the
    # plain __call__ dispatch is not available on the RecursiveScriptModule.
    # It has to be reached THROUGH self.memory, otherwise the tracer refuses it
    # ("not part of the active trace").
    class Stateless(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.memory = inner.memory
            self.actor = inner.actor

        def forward(self, obs, h_in, c_in):
            call = getattr(self.memory, "forward__0", None) or self.memory.forward
            out, (h_out, c_out) = call(obs.unsqueeze(0), (h_in, c_in))
            return self.actor(out.squeeze(0)), h_out, c_out

    wrapper = Stateless(module).eval()
    dummy = (torch.zeros(1, NUM_OBS), torch.zeros(LSTM_LAYERS, 1, HIDDEN_SIZE),
             torch.zeros(LSTM_LAYERS, 1, HIDDEN_SIZE))
    torch.onnx.export(
        wrapper, dummy, POLICY_ONNX,
        input_names=["obs", "h_in", "c_in"],
        output_names=["actions", "h_out", "c_out"],
        opset_version=17, dynamo=False,
    )

    import onnxruntime as ort
    sess = ort.InferenceSession(POLICY_ONNX, providers=["CPUExecutionProvider"])
    names = [i.name for i in sess.get_inputs()]
    outs = [o.name for o in sess.get_outputs()]

    # Parity over a 64-step rollout of random observations: the ORIGINAL
    # stateful module vs the exported graph with state threaded by the caller.
    rng = np.random.default_rng(659)
    module.hidden_state.zero_()
    module.cell_state.zero_()
    h = np.zeros((LSTM_LAYERS, 1, HIDDEN_SIZE), dtype=np.float32)
    c = np.zeros((LSTM_LAYERS, 1, HIDDEN_SIZE), dtype=np.float32)
    max_abs = 0.0
    for _ in range(64):
        x = rng.standard_normal((1, NUM_OBS)).astype(np.float32)
        with torch.no_grad():
            ref = module(torch.from_numpy(x)).numpy()
        got, h, c = sess.run(outs, {names[0]: x, names[1]: h, names[2]: c})
        max_abs = max(max_abs, float(np.max(np.abs(ref - got))))

    # What a naive (state-ignoring) port would cost: same rollout, state reset
    # to zero before every call.
    module.hidden_state.zero_()
    module.cell_state.zero_()
    rng = np.random.default_rng(659)
    max_abs_stateless = 0.0
    for _ in range(64):
        x = rng.standard_normal((1, NUM_OBS)).astype(np.float32)
        with torch.no_grad():
            ref = module(torch.from_numpy(x)).numpy()
        z = np.zeros((LSTM_LAYERS, 1, HIDDEN_SIZE), dtype=np.float32)
        got, _, _ = sess.run(outs, {names[0]: x, names[1]: z, names[2]: z})
        max_abs_stateless = max(max_abs_stateless, float(np.max(np.abs(ref - got))))

    return {
        "torch": torch.__version__,
        "opset": 17,
        "source_format": "TorchScript, STATEFUL (LSTM buffers mutated in forward)",
        "architecture": {"memory": "nn.LSTM(47 -> 64), 1 layer",
                         "actor": "MLP 64 -> 32 -> 12", "hidden_size": HIDDEN_SIZE,
                         "lstm_layers": LSTM_LAYERS},
        "export_shape": "stateless (obs, h_in, c_in) -> (actions, h_out, c_out)",
        "max_abs_diff_with_state_threaded": max_abs,
        "max_abs_diff_if_state_ignored": max_abs_stateless,
        "inputs": [{"name": i.name, "type": i.type, "shape": i.shape} for i in sess.get_inputs()],
        "outputs": [{"name": o.name, "type": o.type, "shape": o.shape} for o in sess.get_outputs()],
        "custom_metadata": dict(sess.get_modelmeta().custom_metadata_map),
    }


def run(model_path, cmd, steps, capture, mujoco, ort):
    m = mujoco.MjModel.from_xml_path(model_path)
    d = mujoco.MjData(m)
    m.opt.timestep = SIMULATION_DT
    sess = ort.InferenceSession(POLICY_ONNX, providers=["CPUExecutionProvider"])
    in_names = [i.name for i in sess.get_inputs()]
    out_names = [o.name for o in sess.get_outputs()]
    h = np.zeros((LSTM_LAYERS, 1, HIDDEN_SIZE), dtype=np.float32)
    c = np.zeros((LSTM_LAYERS, 1, HIDDEN_SIZE), dtype=np.float32)

    # deploy_mujoco.py keeps the keyframe-free default qpos; the g1_12dof model
    # ships a <key name="home"> only in some variants, so the explicit init
    # below mirrors what the script relies on: default_angles + nominal height.
    if m.nkey > 0:
        mujoco.mj_resetDataKeyframe(m, d, 0)
    else:
        d.qpos[2] = 0.8
        d.qpos[3:7] = [1, 0, 0, 0]
        d.qpos[7:] = DEFAULT_ANGLES
    mujoco.mj_forward(m, d)

    action = np.zeros(NUM_ACTIONS, dtype=np.float32)
    target_dof_pos = DEFAULT_ANGLES.copy()
    obs = np.zeros(NUM_OBS, dtype=np.float32)
    cmd = np.asarray(cmd, dtype=np.float32)
    counter = 0
    control_step = 0
    fixtures = []
    start_xy = d.qpos[0:2].copy()
    min_h = float(d.qpos[2])
    fell_at = None

    while counter < steps * CONTROL_DECIMATION:
        tau = pd_control(target_dof_pos, d.qpos[7:], KPS, np.zeros_like(KDS), d.qvel[6:], KDS)
        d.ctrl[:] = tau
        mujoco.mj_step(m, d)
        counter += 1
        min_h = min(min_h, float(d.qpos[2]))
        if fell_at is None and d.qpos[2] < 0.5:
            fell_at = counter * SIMULATION_DT
        if counter % CONTROL_DECIMATION == 0:
            qj_raw = d.qpos[7:].copy().astype(np.float32)
            dqj_raw = d.qvel[6:].copy().astype(np.float32)
            quat = d.qpos[3:7].copy().astype(np.float32)
            omega_raw = d.qvel[3:6].copy().astype(np.float32)
            raw = {
                "qpos": d.qpos.copy().tolist(),
                "qvel": d.qvel.copy().tolist(),
                "base_quat_wxyz": quat.tolist(),
                "base_ang_vel": omega_raw.tolist(),
                "joint_pos": qj_raw.tolist(),
                "joint_vel": dqj_raw.tolist(),
                "counter": counter,
            }
            prev_action = action.copy()
            h_in, c_in = h.copy(), c.copy()
            qj = (qj_raw - DEFAULT_ANGLES) * DOF_POS_SCALE
            dqj = dqj_raw * DOF_VEL_SCALE
            gravity = get_gravity_orientation(quat)
            omega = omega_raw * ANG_VEL_SCALE
            count = counter * SIMULATION_DT
            phase = count % GAIT_PERIOD / GAIT_PERIOD
            obs[:3] = omega
            obs[3:6] = gravity
            obs[6:9] = cmd * CMD_SCALE
            obs[9:9 + NUM_ACTIONS] = qj
            obs[9 + NUM_ACTIONS:9 + 2 * NUM_ACTIONS] = dqj
            obs[9 + 2 * NUM_ACTIONS:9 + 3 * NUM_ACTIONS] = prev_action
            obs[9 + 3 * NUM_ACTIONS:9 + 3 * NUM_ACTIONS + 2] = [np.sin(2 * np.pi * phase),
                                                                np.cos(2 * np.pi * phase)]
            act_raw, h, c = sess.run(out_names, {in_names[0]: obs.reshape(1, -1),
                                                 in_names[1]: h, in_names[2]: c})
            action = act_raw.squeeze(0).astype(np.float32)
            target_dof_pos = action * ACTION_SCALE + DEFAULT_ANGLES
            if control_step in capture:
                fixtures.append({
                    "control_step": control_step,
                    "sim_time_s": round(count, 6),
                    "input": {
                        "raw_state": raw,
                        "command": cmd.tolist(),
                        "last_action": prev_action.tolist(),
                        "phase": float(phase),
                        "lstm_h_in": h_in.reshape(-1).tolist(),
                        "lstm_c_in": c_in.reshape(-1).tolist(),
                    },
                    "expected": {
                        "observation": obs.copy().tolist(),
                        "action": action.tolist(),
                        "target_dof_pos": target_dof_pos.tolist(),
                        "lstm_h_out": h.reshape(-1).tolist(),
                        "lstm_c_out": c.reshape(-1).tolist(),
                    },
                })
            control_step += 1

    end_xy = d.qpos[0:2].copy()
    summary = {
        "control_steps": control_step,
        "sim_time_s": counter * SIMULATION_DT,
        "base_height_end_m": float(d.qpos[2]),
        "base_height_min_m": min_h,
        "distance_xy_m": float(np.linalg.norm(end_xy - start_xy)),
        "displacement_x_m": float(end_xy[0] - start_xy[0]),
        "fell_at_s": fell_at,
        "finite": bool(np.all(np.isfinite(d.qpos)) and np.all(np.isfinite(d.qvel))),
        "qpos_end": d.qpos.copy().tolist(),
    }
    return fixtures, summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meshroot", required=True,
                    help="directory with scene.xml + g1_12dof.xml + meshes/ (out of repo, see N7)")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    # Phase 0 was re-prioritised mid-run (2026-10-22): Microduck became the demo
    # target and G1 dropped to best-effort, so a failing export is RECORDED, not
    # fought. Everything above it (licence, hashes, tensor contract, matching
    # MJCF) is already established without it.
    try:
        export = export_onnx()
        export["status"] = "ok"
    except Exception as exc:                                  # noqa: BLE001
        export = {"status": "failed", "error": f"{type(exc).__name__}: {exc}",
                  "note": "stateful TorchScript LSTM; see plan-659 Phase 0 report"}
    print("ONNX export:", json.dumps(export, indent=2))

    import mujoco
    import onnxruntime as ort
    scene = os.path.join(args.meshroot, "scene.xml")

    fixtures, run05, run60, deterministic = [], None, None, None
    if export.get("status") == "ok":
        capture = {0, 1, 10, 50, 150}
        fixtures, run05 = run(scene, [0.5, 0.0, 0.0], 500, capture, mujoco, ort)
        _, run60 = run(scene, [0.5, 0.0, 0.0], 3000, set(), mujoco, ort)
        fixtures2, _ = run(scene, [0.5, 0.0, 0.0], 500, capture, mujoco, ort)
        deterministic = bool(all(
            np.array_equal(np.array(a["expected"]["action"]), np.array(b["expected"]["action"]))
            for a, b in zip(fixtures, fixtures2)))

    meta = {
        "plan": 659,
        "phase": 0,
        "generated_by": "spikes/659/make-g1-fixtures.py",
        "sources": {
            "policy": {"repo": "github.com/unitreerobotics/unitree_rl_gym",
                       "revision": "276801e46c5d433564f24658bac64f254b7d2d4b",
                       "path": "deploy/pre_train/g1/motion.pt", "format": "TorchScript"},
            "mjcf": {"repo": "github.com/unitreerobotics/unitree_rl_gym",
                     "revision": "276801e46c5d433564f24658bac64f254b7d2d4b",
                     "path": "resources/robots/g1_description/{scene,g1_12dof}.xml"},
            "reference_loop": {"repo": "github.com/unitreerobotics/unitree_rl_gym",
                               "revision": "276801e46c5d433564f24658bac64f254b7d2d4b",
                               "path": "deploy/deploy_mujoco/deploy_mujoco.py"},
        },
        "runtime_versions": {
            "python": platform.python_version(),
            "mujoco": mujoco.__version__,
            "onnxruntime": ort.__version__,
            "numpy": np.__version__,
            "torch": export.get("torch", "n/a (export failed)"),
            "platform": platform.platform(),
        },
        "onnx_export": export,
        "contract": {
            "obs_size": NUM_OBS,
            "action_size": NUM_ACTIONS,
            "observation_layout": [
                "base_ang_vel[3] * 0.25 (qvel[3:6], NOT a gyro sensor)",
                "gravity_orientation[3] (closed form from qpos[3:7])",
                "command[3] * [2.0, 2.0, 0.25]",
                "joint_pos[12] = (qpos[7:] - default_angles) * 1.0",
                "joint_vel[12] = qvel[6:] * 0.05",
                "last_action[12]",
                "[sin(2*pi*phase), cos(2*pi*phase)] with phase = (counter*dt) % 0.8 / 0.8",
            ],
            "no_observation_clipping": True,
            "action_scale": ACTION_SCALE,
            "control": "tau = (target_q - q)*kp + (0 - dq)*kd, written to ctrl EVERY physics step",
            "actuator_type": "motor (torque), gain 1, no forcerange",
            "target_dof_pos": "action * 0.25 + default_angles",
            "timestep": SIMULATION_DT,
            "decimation": CONTROL_DECIMATION,
            "policy_rate_hz": 1.0 / (SIMULATION_DT * CONTROL_DECIMATION),
            "kps": KPS.tolist(), "kds": KDS.tolist(),
            "default_angles": DEFAULT_ANGLES.tolist(),
            "joint_names": JOINT_NAMES,
            "matching_mjcf": "g1_12dof.xml (12 DoF); the Menagerie unitree_g1 model is 29 DoF "
                             "with position actuators and does NOT match this policy",
        },
        "determinism": {"two_identical_runs_bit_equal": deterministic},
        "runs": {
            "walk_vx0.5_10s": None if run05 is None else {k: v for k, v in run05.items() if k != "qpos_end"},
            "walk_vx0.5_60s": None if run60 is None else {k: v for k, v in run60.items() if k != "qpos_end"},
        },
    }
    with open(os.path.join(OUT, "g1-reference-fixtures.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "fixtures": fixtures}, f, indent=2)
    print(json.dumps({"determinism": deterministic, "runs": meta["runs"],
                      "fixtures": len(fixtures)}, indent=2))


if __name__ == "__main__":
    main()
