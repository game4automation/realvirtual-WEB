# realvirtual Live Sync for Isaac Sim / Omniverse Kit

`realvirtual.livesync` is a Kit extension that receives the running simulation
of realvirtual WEB — every moving axis and every workpiece (MU) — and shows it
live in NVIDIA Isaac Sim or any other Kit app. The direction is one way:
the browser simulates, Isaac Sim displays. Nothing is streamed back.

```
Browser (realvirtual WEB)                     Isaac Sim (same PC)
USD button ▸ Sync to Isaac Sim  ── ws://127.0.0.1:8775 ──▶  realvirtual.livesync
  1. scene snapshot (.usdz, gzip)                           /World/realvirtual  (reference)
  2. 30 Hz: changed axes + MU spawn / move / delete         /World/realvirtual/MUs/mu_<id>
```

## Requirements

- Isaac Sim 4.5 or newer (or another Kit app with `omni.usd` and `omni.ui`).
  Verified with Isaac Sim 4.5.0 (Kit 106.5, Python 3.10), see
  [Troubleshooting (verified on a laptop)](#troubleshooting-verified-on-a-laptop).
- Browser and Isaac Sim on the **same machine** — the extension listens on
  `127.0.0.1` only.
- Chrome or Edge. On the first click on *Sync to Isaac Sim* Chrome may ask to
  allow access to devices on your local network — allow it, otherwise the
  connection to `127.0.0.1` is blocked.
- The Python package `websockets` (>= 12) inside Kit's Python. Isaac Sim ships
  it; for another Kit app see [websockets missing](#websockets-missing).

## Install

The extension comes with realvirtual WEB — no Git checkout needed:

1. In realvirtual WEB open the **USD** button in the left tool bar and click
   **Download extension (v…)** under *Isaac Sim extension*. You get
   `realvirtual-livesync-<version>.zip`.
2. Unzip it anywhere, e.g. `C:\realvirtual-livesync`. The folder contains
   `exts\`, the two start scripts and this README.
3. Start Isaac Sim with one of the scripts (next section) and copy the access
   token from the **realvirtual Live Sync** panel (see [Connect](#connect)).

To update, download the zip again and replace the folder. When the connected
extension is older than the viewer expects, the USD menu and the status pill
show *Isaac Sim extension outdated (vX) — download vY*; syncing keeps working
until you update. An extension that speaks a different protocol version is
refused with a clear message instead of being mounted.

## Start

Double-click **`run_isaac_sim_with_realvirtual.bat`**. It looks for Isaac Sim in
`%ISAACSIM_PATH%`, `C:\isaacsim` and `%USERPROFILE%\isaacsim` and starts it with

```
isaac-sim.bat --ext-folder "<this folder>\exts" --enable realvirtual.livesync
```

Extra arguments are passed through, e.g. a different port:
`run_isaac_sim_with_realvirtual.bat --/exts/realvirtual.livesync/port=8776`.

Manual alternative: *Window ▸ Extensions ▸ ⚙ (settings) ▸ Extension Search Paths*
→ add `<this folder>\exts`, then enable **realvirtual Live Sync**.

On a laptop with an integrated GPU next to the NVIDIA GPU use
**`run_isaac_sim_nvidia_only.bat`** instead: it restricts Vulkan to the NVIDIA
driver (`VK_ICD_FILENAMES`, read from the registry on every start because the
path changes with every driver update), selects GPU 0
(`--/renderer/activeGpu=0`) and then calls `run_isaac_sim_with_realvirtual.bat`
with all further arguments. See
[Troubleshooting (verified on a laptop)](#troubleshooting-verified-on-a-laptop).

## Connect

1. The panel **realvirtual Live Sync** shows the port and the **access token**.
   The token is generated once and stored in `~/.realvirtual/livesync-token.txt`
   (**New** creates a fresh one).
2. In realvirtual WEB open the **USD** button in the left tool bar, click the
   gear, paste the token (and change the port if you changed it).
3. Switch **Sync to Isaac Sim** on. The viewer exports the running scene,
   uploads it, and from then on streams the motion. The pill next to the
   simulation controls shows the state and the effective rate. Clicking the
   pill or the switch stops syncing.

Simulation reset, a model change and a restart of Isaac Sim are handled
automatically: after every (re-)connect the scene is mounted again and the full
state is sent.

## What is synced

| Synced | Not synced |
|--------|------------|
| Local transforms of every drive and everything below it | Lamps, colours, visibility changes, signals |
| MUs from sources: spawn, world pose, delete | Physics in Isaac Sim |
| Pre-placed MUs: world pose, delete / reset | Anything from Isaac Sim back to the browser |

The stage is a snapshot of the **running** viewer scene (one prim per runtime
node), Y-up in metres, mounted under `/World/realvirtual` with +90° about X when
the Isaac Sim stage is Z-up. MU templates are hidden; every spawned MU is a
reference to its template under `/World/realvirtual/MUs`.

## Settings

| Setting | Default |
|---------|---------|
| `/exts/realvirtual.livesync/port` | `8775` (was `8765` up to extension 0.2.0) |
| `/exts/realvirtual.livesync/allowed_origins` | `http://localhost:*`, `http://127.0.0.1:*`, `https://localhost:*`, `https://127.0.0.1:*`, `https://*.realvirtual.io` |
| `/exts/realvirtual.livesync/token` | generated, see above |

Add your own viewer origin (e.g. a customer deployment) to `allowed_origins`.

### Changing the port

Both sides must use the same port. The default is **8775**. It was 8765 up to
extension 0.2.0, but other local tools use 8765 too (e.g. DeskAgent).

- **Isaac Sim:** start with `--/exts/realvirtual.livesync/port=<port>` (see
  [Start](#start)), or set `exts."realvirtual.livesync".port` in
  `config/extension.toml`.
- **realvirtual WEB:** **USD** button ▸ gear ▸ **Port**. The value is stored per
  browser. A new port restarts a running (or failed) sync right away.

A viewer that only ever stored the old default 8765 moves to 8775 on its own.
A port you typed into the menu stays as it is. If you keep an older extension
(0.2.0) on 8765, set the viewer's port back to 8765.

On the WebSocket port the extension also answers a plain
`GET /realvirtual-livesync` with `{"service":"realvirtual.livesync","version":…,"protocol":…}`
(`Access-Control-Allow-Origin: *`, no token, no secret). The viewer uses this
answer to tell the extension apart from another program on the same port. The
token and origin checks of the WebSocket do not change.

## Security

- Binds `127.0.0.1` only — not reachable from other machines.
- Exactly one client at a time; a second one is refused.
- Nothing touches the stage before a valid `hello` with the token, from an
  allowed origin, within 10 s.
- Limits: compressed scene ≤ 256 MB, unpacked ≤ 1 GB (checked while
  unpacking), upload chunk ≤ 512 KB, ≤ 256 queued frames. Invalid frames are
  answered with an error and dropped.

## websockets missing

Isaac Sim ships `websockets`, so the extension declares no `[python.pipapi]`
dependency and installs nothing. In a Kit app without it the extension fails to
load with `No module named 'websockets'`; install it into that app's Python
once (`<kit-app>\python.bat -m pip install "websockets>=12"`) and restart.

## Log

The extension writes to the Kit log (`carb.log_*`, prefix
`[realvirtual.livesync]`): listening port, client connected (origin), auth ok /
refused (reason), mount begin and end (bytes compressed / unpacked, duration,
file), stage opened or failed (with traceback), reset, client disconnected
(close code, reason) and every 10 s the applied rate (frames/s, nodes moved).
Nothing is logged per frame. Info lines go to the log file
(`%USERPROFILE%\.nvidia-omniverse\logs\Kit\<app>\<version>\`); to see them in
the console start with `--/log/outputStreamLevel=Info`. Warnings and errors
always show.

If the port is taken, the extension logs **one** error that names the owner
(`netstat -ano` + `tasklist` on Windows, `lsof` elsewhere, best effort) and the
setting to change, e.g.:

```
[realvirtual.livesync] Port 8775 is taken by pythonw.exe (pid 33840) - change /exts/realvirtual.livesync/port and the port in realvirtual WEB (USD > Settings) to the same free port
```

## Troubleshooting

| Message in the viewer | Cause |
|-----------------------|-------|
| *Isaac Sim is not reachable* | Isaac Sim not started, extension not enabled, wrong port, or Chrome blocked the local connection (site settings ▸ *Local network access*). |
| *Port N is used by another program (not realvirtual.livesync)* | Another program holds the port and refused the connection. The viewer stops retrying. Pick a free port and set it on both sides (see [Changing the port](#changing-the-port)). |
| *Isaac Sim refused the access token* | Token in the viewer differs from the panel. |
| *does not accept connections from this page* | The viewer's origin is not in `allowed_origins`. |
| *Another viewer is already connected* | Close the other tab or switch its sync off. |
| *The scene is too large for the live link* | Above the limits — very large customer models are not supported in this version. |
| *N textures skipped (not exportable)* | The scene has textures the USD export cannot write (compressed KTX2 textures, textures without loaded image data). They are left out of the Isaac Sim stage; colours and material factors stay. Raw data textures and video frames are converted and do not count. |

## Troubleshooting (verified on a laptop)

Field test of the live link (mount of a 137 MB `.usdz`) on a gaming laptop with
an NVIDIA GPU next to an Intel iGPU, with **Isaac Sim 4.5.0 (Kit 106.5,
Python 3.10)**. Note: the Isaac Sim download page labelled "6.2.0" actually
delivered 4.5.0 — check *Help ▸ About* before comparing versions.

| Symptom | Fix |
|---------|-----|
| Isaac Sim does not start: *Multiple ICDs found for the same GPU* / *Failed to create any GPU devices* | A virtual display driver registers a second Vulkan device. Disable the **Meta Virtual Monitor** (Quest Link) in the Device Manager. If the Intel iGPU is still registered twice, start with **`run_isaac_sim_nvidia_only.bat`** — it limits Vulkan to the NVIDIA ICD, whose path it reads from the registry on every start. |
| Crash in `rtx.scenedb.plugin.dll` right after start | NVIDIA driver series 595+ / 617 are not validated for Isaac Sim 4.5. Install the validated driver **580.88**. |
| The window freezes after a driver change, the log shows *Waiting for RtPso async group async compilation* | The first start after a driver change compiles the RTX shaders — up to **~25 minutes**. Do **not** close the window: an interrupted compilation starts over. |
| No GPU / no window when started over SSH, as a service or through RDP | Isaac Sim needs the interactive desktop session with the GPU. Start it locally on the machine; a session over SSH or a Windows service has no GPU, RDP replaces the display driver. |
| Testing from another machine | Keep Isaac Sim on the laptop and forward the port: `ssh -L 8775:127.0.0.1:8775 <user>@<laptop>`, then the viewer on your machine connects to `127.0.0.1:8775` as usual (the extension still only listens on loopback). |
| Kit warns *has a [python.pipapi] entry, but use_online_index=true is not set* | Old version of the extension — the entry is gone; download the current extension from the USD menu (see [Install](#install)). |
| The viewer shows *Isaac Sim extension outdated* | The extension in Isaac Sim is older than the viewer expects. Download the current zip from the USD menu, replace the folder and restart Isaac Sim. |

## Development

The extension's Python modules are split so they run without Kit:

| Module | Needs |
|--------|-------|
| `protocol.py` — wire format v1 | Python |
| `server.py` — WebSocket server, auth, limits, delta merge | `websockets` |
| `stage_usd.py` — mount, matrices, MUs | `pxr` (`usd-core`) |
| `extension.py`, `panel.py` — Kit wiring, carb log bridge | Kit |

Tests (no Kit needed):

```
python -m pip install pytest websockets usd-core
python -m pytest integrations/omniverse-kit/tests
```

The wire format is pinned by `tests/golden_v1.json`, shared with the TypeScript
test `tests/usd-live-link-protocol.test.ts` — change both encoders together.
Protocol reference: `doc-extending-webviewer.md` § *USD live link*.
