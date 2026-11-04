#!/usr/bin/env python3
"""plan-659 Phase 0 - reference fixtures for the Microduck policy pair.

Reproduces the control loop of pollen-robotics/microduck_rl @ b02fdea4
(scripts/infer_policy.py, --new-cmd-obs path) against the MJCF the HF Space
pollen-robotics/microduck-simulator @ ad9d41a7 uses, and dumps, per captured
control step, the RAW state -> observation -> action triple that test 9.7
checks the TypeScript port against (two stages: observation build, ORT action).

Scene preparation mirrors app/src/game/game.js:buildPhysicsXml() of the Space
(strip visual geoms, drop unreferenced mesh assets, inject an option timestep,
a floor plane and the STAND keyframe) MINUS the arena walls, the ball and the
relief hfield: those add qpos entries and change nothing about the
observation-to-action mapping, and leaving them out keeps the fixture
reproducible from the two Apache-2.0 sources alone.

Run:  <venv>/python make-microduck-fixtures.py
"""
import hashlib
import json
import os
import platform
import re
import xml.etree.ElementTree as ET

import numpy as np
import mujoco
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures", "microduck")
MJCF = os.path.join(FIX, "mjcf", "robot_allcollisions.xml")
OUT = os.path.join(FIX, "reference")

# --- constants, verbatim from the ONNX metadata / the Space constants.js ---
JOINT_NAMES = [
    "left_hip_yaw", "left_hip_roll", "left_hip_pitch", "left_knee", "left_ankle",
    "neck_pitch", "head_pitch", "head_yaw", "head_roll",
    "right_hip_yaw", "right_hip_roll", "right_hip_pitch", "right_knee", "right_ankle",
]
DEFAULT_POSE = np.array([
    0.0, -0.08726646259971647, -0.457924, -0.004940, 0.452984,
    0.3490658503988659, 0.3490658503988659, 0.0, 0.0,
    0.0, 0.08726646259971647, 0.457924, 0.004940, -0.452984,
], dtype=np.float32)
TIMESTEP, DECIMATION, ACTION_SCALE = 0.005, 4, 1.0
OBS_SIZE, NUM_JOINTS, CMD_SIZE = 61, 14, 13
INIT_BASE_Z = 0.125   # infer_policy.py line 1379 (non-roller)


def build_physics_xml(path):
    """Space buildPhysicsXml() minus arena/ball/relief. Returns the xml string."""
    tree = ET.parse(path)
    root = tree.getroot()
    for parent in root.iter():
        for g in [c for c in list(parent) if c.tag == "geom" and c.get("class") == "visual"]:
            parent.remove(g)
    used = {g.get("mesh") for g in root.iter("geom") if g.get("mesh")}
    for asset in root.iter("asset"):
        for m in [c for c in list(asset) if c.tag == "mesh"]:
            name = m.get("name") or re.sub(r"\.stl$", "", m.get("file"), flags=re.I)
            if name not in used:
                asset.remove(m)
    ET.SubElement(root, "option", {"timestep": str(TIMESTEP)})
    wb = root.find("worldbody")
    ET.SubElement(wb, "geom", {
        "name": "floor", "type": "plane", "size": "0 0 0.05", "pos": "0 0 0",
    })
    pose_by_name = dict(zip(JOINT_NAMES, DEFAULT_POSE.tolist()))
    qpos_joints = []
    for body in root.iter("body"):
        for j in body.findall("joint"):
            qpos_joints.append(pose_by_name.get(j.get("name"), 0.0))
    kf = ET.SubElement(root, "keyframe")
    ET.SubElement(kf, "key", {
        "name": "STAND",
        "qpos": "0 0 0.12 1 0 0 0 " + " ".join(repr(v) for v in qpos_joints),
        "ctrl": " ".join(repr(v) for v in DEFAULT_POSE.tolist()),
    })
    return ET.tostring(root, encoding="unicode")


def quat_rotate_inverse(q, v):
    """infer_policy.py quat_rotate_inverse, quaternion order w,x,y,z."""
    w, x, y, z = float(q[0]), float(q[1]), float(q[2]), float(q[3])
    q_vec = np.array([x, y, z], dtype=np.float32)
    a = v * (2.0 * w * w - 1.0)
    b = np.cross(q_vec, v) * (-2.0 * w)
    c = q_vec * (float(q_vec @ v) * 2.0)
    return (a + b + c).astype(np.float32)


class Loop:
    def __init__(self, model, data, session):
        self.m, self.d, self.s = model, data, session
        self.trunk = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "trunk_base")
        self.gyro = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SENSOR, "imu_ang_vel")
        self.qpos_idx = [int(model.jnt_qposadr[model.actuator_trnid[i, 0]]) for i in range(model.nu)]
        self.qvel_idx = [int(model.jnt_dofadr[model.actuator_trnid[i, 0]]) for i in range(model.nu)]
        self.last_action = np.zeros(NUM_JOINTS, dtype=np.float32)
        self.command = np.zeros(CMD_SIZE, dtype=np.float32)
        self.in_name = session.get_inputs()[0].name
        self.out_name = session.get_outputs()[0].name

    def raw_state(self):
        adr = int(self.m.sensor_adr[self.gyro])
        return {
            "qpos": self.d.qpos.copy().tolist(),
            "qvel": self.d.qvel.copy().tolist(),
            "base_quat_xquat_wxyz": self.d.xquat[self.trunk].copy().tolist(),
            "base_ang_vel_gyro": self.d.sensordata[adr:adr + 3].copy().tolist(),
            "joint_pos": self.d.qpos[self.qpos_idx].copy().tolist(),
            "joint_vel": self.d.qvel[self.qvel_idx].copy().tolist(),
        }

    def observation(self):
        adr = int(self.m.sensor_adr[self.gyro])
        ang = self.d.sensordata[adr:adr + 3].copy().astype(np.float32)
        grav = quat_rotate_inverse(
            self.d.xquat[self.trunk].copy().astype(np.float32),
            np.array([0.0, 0.0, -1.0], dtype=np.float32),
        )
        jp = self.d.qpos[self.qpos_idx].copy().astype(np.float32) - DEFAULT_POSE
        jv = self.d.qvel[self.qvel_idx].copy().astype(np.float32)
        return np.concatenate([ang, grav, jp, jv, self.last_action, self.command]).astype(np.float32)

    def control_step(self):
        obs = self.observation()
        action = self.s.run([self.out_name], {self.in_name: obs.reshape(1, -1)})[0]
        action = action.squeeze(0).astype(np.float32)
        self.last_action = action.copy()
        ctrl = DEFAULT_POSE + action * ACTION_SCALE
        self.d.ctrl[:] = ctrl
        for _ in range(DECIMATION):
            mujoco.mj_step(self.m, self.d)
        return obs, action, ctrl


def make(model, policy_path, vx, capture, steps):
    data = mujoco.MjData(model)
    session = ort.InferenceSession(policy_path, providers=["CPUExecutionProvider"])
    loop = Loop(model, data, session)
    fj = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, "trunk_base_freejoint")
    a = int(model.jnt_qposadr[fj])
    data.qpos[a + 0] = 0.0
    data.qpos[a + 1] = 0.0
    data.qpos[a + 2] = INIT_BASE_Z
    data.qpos[a + 3:a + 7] = [1, 0, 0, 0]
    for i, qi in enumerate(loop.qpos_idx):
        data.qpos[qi] = DEFAULT_POSE[i]
    data.ctrl[:] = DEFAULT_POSE
    mujoco.mj_forward(model, data)
    loop.command[0] = vx
    out = []
    start_xy = data.qpos[a:a + 2].copy()
    min_h = float(data.qpos[a + 2])
    for k in range(steps):
        pre = loop.raw_state()
        pre_last_action = loop.last_action.copy().tolist()
        pre_cmd = loop.command.copy().tolist()
        obs, action, ctrl = loop.control_step()
        min_h = min(min_h, float(data.qpos[a + 2]))
        if k in capture:
            out.append({
                "control_step": k,
                "sim_time_s": round(k * TIMESTEP * DECIMATION, 6),
                "input": {"raw_state": pre, "command": pre_cmd, "last_action": pre_last_action},
                "expected": {
                    "observation": obs.tolist(),
                    "action": action.tolist(),
                    "ctrl_position_target": ctrl.tolist(),
                },
            })
    end_xy = data.qpos[a:a + 2].copy()
    return out, {
        "control_steps": steps,
        "sim_time_s": steps * TIMESTEP * DECIMATION,
        "base_height_end_m": float(data.qpos[a + 2]),
        "base_height_min_m": min_h,
        "distance_xy_m": float(np.linalg.norm(end_xy - start_xy)),
        "displacement_x_m": float(end_xy[0] - start_xy[0]),
        "mean_speed_x_mps": float((end_xy[0] - start_xy[0]) / (steps * TIMESTEP * DECIMATION)),
        "qpos_end": data.qpos.copy().tolist(),
        "finite": bool(np.all(np.isfinite(data.qpos)) and np.all(np.isfinite(data.qvel))),
    }


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 16), b""):
            h.update(b)
    return h.hexdigest()


def main():
    os.makedirs(OUT, exist_ok=True)
    xml = build_physics_xml(MJCF)
    # Written NEXT TO the MJCF so the compiler meshdir="assets" still resolves.
    prepared = os.path.join(FIX, "mjcf", "prepared-scene.xml")
    with open(prepared, "w", encoding="utf-8") as f:
        f.write(xml)
    model = mujoco.MjModel.from_xml_path(prepared)
    print("model loaded: nq=%d nv=%d nu=%d nbody=%d ngeom=%d"
          % (model.nq, model.nv, model.nu, model.nbody, model.ngeom))
    assert model.nu == NUM_JOINTS, model.nu

    walk = os.path.join(FIX, "policies", "BEST_alpha_walking.onnx")
    stand = os.path.join(FIX, "policies", "BEST_alpha_stand.onnx")

    # vx = 0.25 m/s is the Space's own VEL_FWD and the LOWEST command that
    # starts a gait: at vx <= 0.2 the walking policy holds a static stance
    # (see runs.walk_vx0.2_10s below). Fixtures are therefore captured from a
    # real gait, not from a stance.
    capture = {0, 1, 10, 50, 150}
    fixtures, run = make(model, walk, 0.25, capture, 500)
    fixtures2, run2 = make(model, walk, 0.25, capture, 500)
    deterministic = bool(
        all(np.array_equal(np.array(a["expected"]["action"]), np.array(b["expected"]["action"]))
            for a, b in zip(fixtures, fixtures2))
        and np.array_equal(np.array(run["qpos_end"]), np.array(run2["qpos_end"]))
    )

    _, walk02 = make(model, walk, 0.2, set(), 500)
    _, walk60 = make(model, walk, 0.25, set(), 3000)
    _, stand3 = make(model, stand, 0.0, set(), 150)

    meta = {
        "plan": 659,
        "phase": 0,
        "generated_by": "spikes/659/make-microduck-fixtures.py",
        "sources": {
            "mjcf": {
                "repo": "huggingface.co/spaces/pollen-robotics/microduck-simulator",
                "revision": "ad9d41a7",
                "path": "app/public/robot/mjlab/robot_allcollisions.xml",
            },
            "policies": {
                "repo": "huggingface.co/spaces/pollen-robotics/microduck-simulator",
                "revision": "ad9d41a7",
                "path": "app/public/policies/",
            },
            "reference_loop": {
                "repo": "github.com/pollen-robotics/microduck_rl",
                "revision": "b02fdea4902c2b93b7d34a83a6f05da4ececb7d3",
                "path": "scripts/infer_policy.py",
                "mode": "--new-cmd-obs",
            },
        },
        "runtime_versions": {
            "python": platform.python_version(),
            "mujoco": mujoco.__version__,
            "onnxruntime": ort.__version__,
            "numpy": np.__version__,
            "platform": platform.platform(),
        },
        "browser_target_versions": {"@mujoco/mujoco": "^3.11.0", "onnxruntime-web": "^1.27.0"},
        "contract": {
            "obs_size": OBS_SIZE,
            "action_size": NUM_JOINTS,
            "command_size": CMD_SIZE,
            "observation_layout": [
                "base_ang_vel[3] from gyro sensor imu_ang_vel",
                "projected_gravity[3] = quat_rotate_inverse(xquat[trunk_base], [0,0,-1])",
                "joint_pos[14] = qpos - DEFAULT_POSE",
                "joint_vel[14]",
                "last_action[14]",
                "command[13] = twist[3] + head_pose[4] + body_pose[6]",
            ],
            "no_observation_scaling": True,
            "no_observation_clipping": True,
            "action_scale": ACTION_SCALE,
            "ctrl": "DEFAULT_POSE + action * action_scale",
            "timestep": TIMESTEP,
            "decimation": DECIMATION,
            "policy_rate_hz": 1.0 / (TIMESTEP * DECIMATION),
            "joint_names": JOINT_NAMES,
            "default_pose": DEFAULT_POSE.tolist(),
            "init_base_z_m": INIT_BASE_Z,
            "model_dims": {"nq": int(model.nq), "nv": int(model.nv), "nu": int(model.nu)},
            "actuator_class": {
                "name": "chosen_actuator", "type": "position",
                "kp": 0.55, "kv": 0.0, "forcerange": [-0.96, 0.96], "ctrlrange": [-10.0, 10.0],
                "joint_damping": 0.053, "joint_frictionloss": 0.0048, "joint_armature": 0.0018,
            },
        },
        "determinism": {"two_identical_runs_bit_equal": deterministic},
        "gait_onset_finding": (
            "The walking policy only starts a gait at vx >= 0.25 m/s, which is "
            "exactly the Space's VEL_FWD. At vx <= 0.2 it holds a static stance "
            "(upright, no fall, ~1.3 cm of drift in 10 s). A 'no fall' assertion "
            "at vx = 0.2 therefore passes trivially; test 9.9 must command 0.25."
        ),
        "runs": {
            "walk_vx0.25_10s_baseline": {k: v for k, v in run.items() if k != "qpos_end"},
            "walk_vx0.2_10s_no_gait": {k: v for k, v in walk02.items() if k != "qpos_end"},
            "walk_vx0.25_60s": {k: v for k, v in walk60.items() if k != "qpos_end"},
            "stand_cmd0_3s": {k: v for k, v in stand3.items() if k != "qpos_end"},
        },
    }
    with open(os.path.join(OUT, "microduck-reference-fixtures.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "fixtures": fixtures}, f, indent=2)
    with open(os.path.join(OUT, "microduck-qpos-after-500-steps.json"), "w", encoding="utf-8") as f:
        json.dump({
            "meta": {k: meta[k] for k in ("runtime_versions", "sources")},
            "control_steps": 500,
            "command": [0.25] + [0.0] * 12,
            "qpos": run["qpos_end"],
        }, f, indent=2)
    print(json.dumps({
        "deterministic": deterministic,
        "runs": meta["runs"],
        "fixtures": len(fixtures),
    }, indent=2))


if __name__ == "__main__":
    main()
