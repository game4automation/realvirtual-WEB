# Tutorial recorder (plan-2004)

The tutorial recorder plays a **storyboard** against a finished realvirtual WEB build and records
it frame by frame: the mouse moves visibly and human-like to its target, every step is held as
long as the storyboard says, and next to the video it writes an **event trace** of everything that
happened, in video time.

**The result is raw footage for manual cutting — not a film.** There is no voice, no cursor drawn
into the pixels, no automatic zoom, no tempo cut and no final render here (Thomas, 2026-10-26:
*"voice won't be done automatically — just a source for later cutting"*). All of that is the cut
(plan-676) and starts where this tool ends.

## The handover

A successful output folder contains, flat:

| File | What it is |
|------|------------|
| `recording.mp4` | The raw take: H.264, exactly 30 fps CFR, GOP 30, 1920x1080 by default. **No resampling — the frame number IS the video time** (`t = frame / fps`, nothing else). With the default `stamp: "proof"` it is the **pristine app** — no frame stamp in any pixel; only the magenta start/end markers (Gate B) are in it. |
| `stamp-proof.mp4` | The **proof track** (`stamp: "proof"`, plan-2043): per video frame the 320x20 frame stamp grabbed in the SAME virtual frame, 320x20, same fps and frame count as `recording.mp4`. Gate A reads it. Absent with `stamp: "inline"`. |
| `events.json` | The event trace `rv-tutorial-events/1` (below) — the real deliverable beside the video. |
| `motion-control.jpg` | The decoder control frame of Gate C (middle frame of the run). |
| `stills-f<frame>-<roles>.jpg` | The **contact sheet** for the acceptance: every click, every camera flight, every step start, plus run start, middle and end. |

`events.json` is published **last**, after the video, the control frame and every still. A folder
**with** `events.json` is a complete set; a folder without one is an unfinished recording. That is
the one guarantee the publication order buys (see *Publication*).

The cursor is **not** in the pixels: headless Chrome draws none, and a burned-in cursor could not be
smoothed, sped up or kept at a constant size in the cut. Its path is `events.pointer` — the cut
draws it.

## Running it

```sh
npm run build    # the runner does NOT build; it needs a finished dist/
npm run tutorial:run -- --script scripts/tutorial/storyboards/demo-basics.json \
  --ffmpeg "E:/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe" \
  --ffprobe "E:/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe"
```

```
node scripts/tutorial/run.mjs --script <storyboard.json>
  [--dir <output folder>] [--dist <folder>] [--port 5199] [--base <url>] [--overwrite]
  [--ffmpeg <path>] [--ffprobe <path>] [--gpu-check require|off] [--motion-check require|off]
  [--keep-temp] [--epoch-zero-diagnosis] [--burn-cursor] [--stamp proof|inline]
```

| Option | Meaning |
|--------|---------|
| `--script` | The storyboard. **Input**, versioned under `scripts/tutorial/storyboards/<id>.json`. |
| `--dir` | The output folder. Default `<WebViewer repo>/.tutorial-out/<id>/` (gitignored). **Must resolve inside the WebViewer repo and must not be its root** — anything else is Exit 2 `dir-outside-repo`, checked before the browser starts. The check is canonical, not a prefix compare: `path.resolve` → nearest existing ancestor → `fs.realpathSync.native` → `path.relative(repo, target)`, accepted only when non-empty, not absolute (other drive) and not `..`. A sibling `<repo>-outside`, `..` and a symlink/junction escape are all refused. Copying the footage into `E:/remotion/...` is plan-676's job, as a copy — never a recording target. |
| `--dist` | The finished static build (default `dist/`). Missing `index.html` → Exit 2 naming `npm run build`. |
| `--port` | The runner's **own** static server, default 5199; a busy port moves on within 5199…5209. 5173 and 5100 are refused (Vite / CONNECT stay untouched). |
| `--base` | Use an external server instead (the E2E fixture or CONNECT); then no own server and no `--dist` check. Required when the storyboard declares `connect: "live"`. |
| `--overwrite` | Replace an existing set. The old set is first moved aside into `<temp>/replaced/`, so an interrupted publication can never leave a new video next to an old trace. |
| `--ffmpeg` / `--ffprobe` | The encoders. Resolution: `--ffmpeg` > `RV_FFMPEG` > `RV_REMOTION_ROOT` > upward search from the WebViewer repo for `node_modules/@remotion/compositor-*/ffmpeg(.exe)`; `--ffprobe` > `RV_FFPROBE` > next to that ffmpeg. **The upward search does not carry on the dev machines** — `E:/remotion` is a sibling of the workspace — so pass both paths (or set `RV_REMOTION_ROOT`). Without them the run is Exit 2 before anything happens. |
| `--gpu-check` | `require` (default): no WebGL context, or a software renderer (SwiftShader, llvmpipe) → Exit 1. `off` exists for the canvas-less E2E fixture only. |
| `--motion-check` | `require` (default). `off` is accepted **only** with `--gpu-check off` **and** a page without a WebGL canvas; anything else is Exit 2 `motion-check-off-with-viewer`. It is never a production switch. |
| `--keep-temp` | Keep the run's temp folder after a successful publication. |
| `--stamp` | `proof` or `inline`; overrides the storyboard's `stamp` (default `proof`). Anything else is Exit 2 `usage`. |
| `--epoch-zero-diagnosis` | A measuring mode that **never publishes**: forces virtual-clock epoch 0, records 40 frames anyway, runs Gate C as a measurement (no threshold assertion) and ends with Exit 1 `virtual-clock-epoch`. Needs a viewer (else Exit 2 `epoch-zero-diagnosis-needs-viewer`). The measurement is in the temp folder (`run.log`: `motion`, `motionMadSequence`; `events-failed.json` with `motion`). |

Ctrl+C / SIGTERM abort the run: browser, ffmpeg and server are torn down at once (each step within
15 s) and the run ends with Exit 1 `aborted`, its temp folder kept.

### AI kinematization example

`storyboards/ai-kinematize.json` opens a new empty editor document, asks the AI prompt panel to import
`tools/solidcraft/agv-stacker/agv-stacker.step` through `web_editor_import_cad`, reads the
`kinematize` help and kinematizes the stacker's lift before framing the result. The take requires
CONNECT with *Details › MCP server › Allow prompt window* enabled and an available, signed-in
Claude Code or Codex CLI. Use the panel's backend selector before recording when both are available.

```sh
npm run tutorial:run -- --script scripts/tutorial/storyboards/ai-kinematize.json \
  --base http://127.0.0.1:5100 --burn-cursor
```

This storyboard declares `connect: "live"`, so CONNECT must serve the page at the supplied base.
That keeps the page origin and CONNECT's `/webviewer` channel together. Omitting `--base` is Exit 2
`connect-live-needs-base` before the recorder starts.

The relative STEP path assumes that `AiPrompt:WorkDir` is the Unity repository. CONNECT's dev
start configures that working directory automatically. With any other CONNECT start, put the
absolute STEP path into the storyboard prompt before recording.

The AI runs in real time while the recorder advances the video on its virtual clock. A long prompt
run therefore produces a long wait in the raw footage; `events.json` marks that wait so the Remotion
cut can shorten it without guessing where the AI work started or ended.

## How a take is made

1. **Isolated page.** Own static server on the finished `--dist`, headless Chrome (`channel:
   'chrome'`, ANGLE/D3D11, `--ignore-gpu-blocklist`), `deviceScaleFactor: 1`, viewport = video size.
   The URL always gets `recording=1`. With the default `connect: "off"` it also gets
   `consent=decline` and `mcpPort=1`; with `connect: "live"` neither parameter is forced and
   `--base` is mandatory. localStorage seeds terms, the CONNECT auto-connect opt-out and the
   auto-quality flag; `welcome: 'show'` keeps the welcome dialog. Known nags
   ("Performance mode enabled", the integrated-graphics bar) are dismissed before the take.
   Page preparation clears saved panel geometry and collapsed state (`rv-panel-geo:*` and
   `rv-panel-collapsed:*`) for a repeatable layout.
2. **`setup[]`** runs before the take (not recorded). `waitFor: { scene: true }` polls until
   `viewer.currentModelRoot` is set — and, when `doc` is given, `currentModelUrl === doc` — within
   its `timeoutMs`. Without `doc`, a wrong document that loads successfully passes.
3. **Virtual clock.** An init script replaces `performance.now`, `requestAnimationFrame`,
   `Event.prototype.timeStamp`, `setTimeout` and `setInterval`; `__vt.enable()` seeds the epoch from
   the real `performance.now()` (**never 0** — an epoch of 0 makes the clock jump backwards and the
   simulation freezes while `isSimulationPaused === false`). Timeouts and animation frames that the
   page scheduled before `enable()` move onto the virtual clock with their remaining delay, so
   nothing started during load or setup fires on wall time in the middle of the take.
4. **Null-epoch preflight** (before the take, not recorded): (i) the epoch is > 0, (ii) the clock
   never goes below it, then a **bounded warm-up** of up to `framesOf(2, fps)` frames until the first
   frame with a fixed simulation step (the viewer does not step for ~0.67 s after enabling and then
   catches up in one burst frame — that frame belongs to the warm-up), then **40 frames** in which
   every frame carries ≥ 1 fixed step and `|Σ Δ simTime − 40/fps| ≤ fixedDt_obs + 1e-4 s`
   (`fixedDt_obs = Σ Δ simTime / Σ Δ fixedStepCount`, read from the page). The tolerance is one
   fixed step — the measured jitter. It catches a frozen clock, half and double speed. Any
   violation → Exit 1 `virtual-clock-epoch`. (The viewer integrates with `fixedDt = 1/60`, so at
   30 fps one frame is two steps; the earlier rule "Δ fixedStepCount == 1 per frame" was
   unsatisfiable — decision B2, 2026-10-27.) Without a viewer (`--gpu-check off`) the preflight is
   skipped and the log says `skipped-no-viewer`. With `start: running` (default), the simulation
   must be running during this preflight. With `start: paused`, setup must leave the viewer
   paused (else Exit 1 `setup-not-paused`); preflight checks only a positive, finite epoch and a
   finite, monotonic clock that never falls below it. Simulation progress is checked after the
   recorded start, using the DES factor at that start: the multiplier in `hybrid`, 1 in `animated`.
   Expected progress is `factor * frames / fps`, with tolerance `factor / 60 + 1e-4 s`.
5. **Frame clock.** Per frame: due inputs via CDP → `__vt.step(1000/fps)` →
   `Page.captureScreenshot` (JPEG q95) → ffmpeg. Clicks are `down` + `up` in the **same** frame;
   a click never falls into a held drag. Exactly one pointer sample per frame. Before a click the
   target is re-inspected in that frame (visible, unique, scrolled into view, hit-tested; moved
   more than 2 px → re-approach, at most twice). Playwright's own actionability wait is bypassed
   (`force: true`) because its stability check waits for `requestAnimationFrame`, which only fires
   inside `__vt.step()` — a deadlock under the virtual clock; the own hit test stays.
   Dynamic node and recording targets are re-projected at the click-frame boundary.
6. **Markers and stamp.** A magenta full-area marker for `framesOf(0.2, fps)` frames after a lead
   of `framesOf(0.1, fps)` frames at the start, and again before a tail of `framesOf(0.1, fps)` at
   the end. A 16-bit frame stamp (`320x20` px, top left, LSB first, white = 1) counts the frames.
   - **`stamp: "proof"` (default, plan-2043 "Beleg-Spur").** The stamp is hidden during the app grab
     (and the `--burn-cursor` grab). After them, in the SAME virtual frame (no `__vt.step` in between),
     the runner shows it, grabs ONLY its region (`clip {0, 0, 320, 20}`, inside the viewport) into
     `stamp-proof.mp4`, and hides it again before the next frame's app grab. `recording.mp4` stays the
     pristine app. Every grab is a plain in-viewport `Page.captureScreenshot` — no
     `captureBeyondViewport`, so nothing resizes the page (`run.log` `rendererSetSize`, expected 0).
     Cost: the extra grab needs one more compositor frame — measured on demo-basics about +45…55 % take
     time (≈ 19 ms per frame).
   - **`stamp: "inline"`** (the behaviour before plan-2043): the stamp sits over the app's top-left
     corner **above** the marker in every frame. **Its protection is the stacking of the overlay ROOT
     against the stamp**, not the marker's own z-index (the marker is a child of the root and cannot
     leave its stacking context).
   - Rejected (plan-2043): a stamp band below the app via `captureBeyondViewport`. Chrome sporadically
     reported a transient **1x1** window inside such a capture and the app reacted visibly (a panel jumped
     for the rest of the take) — no resize shield could hide it.

### The storyboard (`rv-tutorial/1`)

```jsonc
{
  "$schema": "rv-tutorial/1",
  "id": "demo-basics",                 // [a-z0-9-]+, becomes part of file names
  "title": "…",
  "url": "/",                          // relative to the server
  "connect": "off",                   // "off" (default) isolates CONNECT; "live" requires --base
  "viewport": { "width": 1920, "height": 1080 },
  "welcome": "show",                   // or "dismiss" (default)
  "ready": "#welcome-title",           // "app ready" selector, default #rv-viewport
  "minStepSec": 2,                     // s, lower bound of a step
  "motionRegion": { "x": 760, "y": 500, "w": 400, "h": 400 },  // video px, Gate C region
  "stamp": "proof",                    // "proof" (default): stamp in stamp-proof.mp4; "inline": in the app corner
  "setup": [ /* actions, not recorded */ ],
  "steps": [
    { "id": "open-demo", "holdSec": 3, "tailSec": 0.4, "zoom": "auto", "actions": [ /* … */ ] }
  ]
}
```

Actions: `click` / `doubleClick` / `hover` (`target`: `{ selector }` or `{ x, y }`, `button`),
`drag` (`from`, `to`, `button`, `durationMs` = 1000), `wheel` (`at`, `deltaY`, `steps` = 1 —
`|deltaY| < 50` is a **trackpad orbit**, not a zoom), `press` (`key`), `type` (`target`, `text`,
`delayMs` = 60 per character), `waitFor` (`selector` + `state`, or `scene: true` [+ `doc`],
`timeoutMs` = 60000), `wait` (`ms`), `camera` (`position`, `target` as `[x, y, z]`,
`durationSec` = 0.6 — a scripted flight via `viewer.animateCameraTo` with viewer-native `Vector3`s,
exactly `framesOf(durationSec, fps)` frames long, then `isCameraAnimating` must be false, else
Exit 1 `camera-animation-not-finished`). **Zoom is a `camera` action**, not the wheel.
`zoom` on a step is only written through for the cut. `voice` / `say` (plan-676) are tolerated and
ignored. All defaults are declared schema defaults, not measurements.

- `command`: `id`, optional `args` and `buttonKey`, `via: 'click' | 'direct'` (default `click`),
  `waitSec` = 0.3 and `maxWaitSec` = 30. Click execution requires exactly one visible command
  button: match `data-rv-command-id`, narrowed by `data-rv-button-id` when `buttonKey` is given.
  No match or several matches give Exit 1 `command-button-missing` / `command-button-ambiguous`.
  Completion is observed through `onExecuted`; if the storyboard supplies `args`, click execution
  checks them against the executed args (Exit 1 `command-args-mismatch`). Direct execution calls
  the recording seam. `waitSec` is the settling wait; `maxWaitSec` bounds command completion.
  `des.fastForward` with `args.untilSimTime` is allowed only in `setup`.
- `pick`: `rule: 'moving-vehicle'`, `among` (path glob), `as` (binding name), `sampleSec` = 0.3.
  Only nodes carrying an `Agv` or `AgvBehavior` component qualify, not their children or MUs.
  The greatest displacement wins, with path order breaking ties; no moving match gives Exit 1
  `pick-no-match`. In the glob, `*` stays within a path segment and `**` crosses segments.

Targets also accept `{ command, buttonKey? }`, `{ node, anchor? }` (`center` by default, or `top`),
and `{ recordingTarget, key }`. An earlier pick binds a path: use `"$name"` in a target's `node`
or recording `key`, or in command `args` (including nested values). These are whole-string
references, not substitutions in selectors or text. Top-level `start` is `running` (default)
or `paused`; it declares the expected setup state, rather than pausing the viewer itself.

Each step is held live until `start + framesOf(holdSec) + framesOf(tailSec)` (at least until its
last action has finished, at least `framesOf(minStepSec)`); the remainder is a `hold` segment.

### The event trace (`rv-tutorial-events/1`)

All coordinates are viewport CSS px = video px (DPR 1); all times are video seconds, all segment
bounds frame numbers (`end` exclusive).

- `connect`: the normalized storyboard connection mode, `"off"` or `"live"`.
- `video`: `file`, `fps`, `width`, `height`, `stamp` (`"proof"` | `"inline"`), `stampProof`
  (`"stamp-proof.mp4"`, only with `proof`), `duration`, `frames` (= the trace's frame count, the
  reference of Gate A). Takes before plan-2043 have no `stamp` field: read it as `"inline"`.
- `pointer[]`: `{ frame, t, x, y }`, at most one per frame — the cursor path for the cut.
- `buttons[]`: `{ t, type: 'down' | 'up', button, x, y }` — the logged point is the point that was
  clicked.
- `keys[]`: `{ t, key, kind: 'press' | 'type' }`.
- `segments[]`: the **global run segment list**, covering `[0; frames)` without a hole:
  `{ kind: 'action' | 'command' | 'wait' | 'hold' | 'marker', start, end, stepId, actionIndex?, target?, approach? }`.
  `marker` ⇔ `stepId === null` (the start window `[0; onset + framesOf(0.2))` and the end window
  `[onset; frames)`, lead and tail included). Segments of a step:
  `segments.filter(s => s.stepId === id)`.
- `steps[]`: `{ id, start, end, holdSec, outcome }` — `start`/`end` are checked against the
  segments by Gate A.
- `sync`: two marker records (`start`, `end`: `onsetFrame`, `expectedFrame`, `offsetFrames`) and
  `driftFrames`.
- `motion`: Gate C (below), a discriminated union on `verdict`.
- `frameCheck`: Gate A (`frames`, `probedFrames`, `stampsContiguous`, `traceContiguous`,
  `traceStepBoundsOk`, `traceFirstStart`, `traceLastEnd`, `budget` — reported only —,
  `waitForActualFrames`, `verdict`).

### Canonical frame conversion

Seconds become frames only through `lib/tutorial-events.mjs`, with `fps` explicit in every call:
`frameToSec(frame, fps)` (exact), `framesOf(sec, fps)` (durations, ceil), `frameAtStart(sec, fps)`
(floor), `frameAtEnd(sec, fps)` (ceil), `framesAtMost(sec, fps)` (upper bounds, floor). Durations
go through `framesOf` field by field, never over a sum. The cut must use the same rule; the test
vector in `tests/tutorial-events.node.test.ts` is the coupling.

## The gates — nothing is published unless all are green

- **Trace check, then Gate A (frame count).** First the trace must be a complete reference
  (`segments[0].start == 0`, `segments.at(-1).end == frames`, contiguous, at most one pointer
  sample per frame, one owner per segment, every step exactly covered by its own segments) —
  otherwise Exit 1 `trace-not-contiguous` and Gate A is not evaluated at all. Then **one**
  instrument: `ffprobe -count_frames` (`nb_read_frames`) must equal `events.video.frames`
  **exactly** (no ±1), and the stamps read back from the video must run `+1` (mod 2^16) over the
  **whole** run, marker frames included. With `stamp: "proof"` the stamps are read from
  `stamp-proof.mp4`, whose `nb_read_frames` must equal `recording.mp4`'s (`frameCheck.proofFrames`).
  Else Exit 1 `frame-count-mismatch`. The storyboard's
  `Σ framesOf` is only a reported plausibility interval (`frameCheck.budget`), never a gate.
- **Gate B (markers).** Both marker onsets on their expected frames (`offsetFrames == 0`, so
  `driftFrames == 0`), read at the probe `x=60, y=600` outside the stamp strip. Else Exit 1
  `marker-mismatch`.
- **Gate C (motion), on the finished MP4.** Metric `mad8x8gray`: `crop` to `motionRegion` →
  `scale=8:8:flags=area` → `format=gray` (**8-bit, 0…255**), per frame pair
  `mad = Σ|cur − prev| / 64`; a frame pair counts as moved at `mad ≥ 0.5` (on the 0…255 scale — on
  a 0..1 scale the same constant would fail every run); `movedFraction = movedFrames / (frames − 1)`
  must be **≥ 0.10**, else Exit 1 `motion-below-threshold`. `longestStillFrames` is reported, not
  gated. The demo scene moves little on its own (24 % moved frames, 45 s longest still stretch) —
  **the storyboard has to bring the motion** (camera flights, orbits). The control frame
  `motion-control.jpg` must differ from black by `mad ≥ 0.5`, else Exit 1 `decoder-blank` (a decoder
  once produced black frames with exit code 0).

## Contact sheet

Frame numbers come **only** from `events.json`: every `buttons` `down` event
(`frameAtStart(t, fps)`), first and last frame of every `camera` segment, every `steps[].start`,
and run start, middle and end. A frame chosen for several roles is stored once, roles joined with
`+` in the order run → step → click → camera:
`stills-f000000-start+step-open-demo.jpg`, `stills-f000412-click-3.jpg`,
`stills-f001980-cam-2-end.jpg`. Extraction is by frame number from the finished MP4 with the same
ffmpeg (`trim=start_frame=N:end_frame=N+1` — see below). The run log carries the summary that goes
with the sheet (steps with `start`/`end`/`holdSec`, clicks, camera flights, `motion`, `frameCheck`).

## Publication, temp folder, exit codes

Every artefact is produced in `<dir>/.tutorial-run-<ISO time>/`; the output folder is not touched
during the run. After all gates: `recording.mp4` → `motion-control.jpg` → every `stills-*.jpg` →
`events.json`, each by `rename` on the same drive. A `rename` that fails mid-way is Exit 1
`publish-incomplete` — the moved files stay, `events.json` is missing, which is how the state is
recognisable; there is no rollback. On success the temp folder is removed (`--keep-temp` keeps it);
on failure it stays, holding `recording-failed.mp4`, `events-failed.json` and `run.log`, and its
path is in the error message. A rerun always starts from scratch.

- **Exit 0** — published.
- **Exit 1** — `step-error`, `virtual-clock-epoch`, `frame-count-mismatch`, `marker-mismatch`,
  `motion-below-threshold`, `decoder-blank`, `ffmpeg-failed`, `server-not-ready`,
  `camera-animation-not-finished`, `trace-not-contiguous`, `publish-incomplete`, `aborted`,
  `command-button-missing`, `command-button-ambiguous`, `command-args-mismatch`, `pick-no-match`,
  `setup-not-paused`.
- **Exit 2** — `usage`, `configuration-error` (missing dist or encoders, an existing set without
  `--overwrite`, no free port), `motion-check-off-with-viewer`, `dir-outside-repo`,
  `epoch-zero-diagnosis-needs-viewer`, `connect-live-needs-base`.

## Instrument findings (this ffmpeg build)

The Remotion compositor ffmpeg is a stripped build; each of these cost a run once:

- No `rawvideo` muxer: pixel readers use `-c:v rawvideo -f avi` and parse the `00dc` chunks.
- The mjpeg input needs `-f image2pipe -c:v mjpeg` (else "unknown codec") and
  `scale=in_range=pc:out_range=tv` (else the full-range JPEGs are clipped).
- No `select`, `fps` or `tile` filter (`-filters` lists only `colorspace, crop, format, scale,
  trim`): single frames are extracted with `trim=start_frame=N:end_frame=N+1`, which addresses by
  frame number — an `-ss` seek returns a different frame.

## Tests

| Suite | Command | What it needs |
|-------|---------|---------------|
| Unit (`tests/tutorial-*.node.test.ts`) | part of `npm run test:node` | nothing |
| Canvas-less E2E (`scripts/tutorial/tutorial.e2e.test.mjs`) | `npm run tutorial:test` | Chrome, both encoders |
| Real viewer (`scripts/tutorial/tutorial.viewer.test.mjs`) | `npm run tutorial:test:viewer` | a current `dist/`, a GPU, both encoders, a load window |

Both browser suites run under the machine-wide test lock (`scripts/with-test-lock.mjs`) and pass
node:test's `t.signal` to the runner, so a timed-out test tears its browser, ffmpeg and server down
instead of leaving them alive.

## Limits

- Chrome/Chromium only (CDP); the take needs a GPU (no SwiftShader).
- Capture path: virtual clock, headless — measured 2026-10-25 as the only path meeting all four
  criteria (2700/2700 frames, gap 0 ms, drift 0 frames, 24/24 clicks at offset exactly 0). CDP
  screencast and `recordVideo` are not used.
- Momentary push-buttons (operator panels) are not measured; there is no "hold key" action yet.

## `--burn-cursor`

`node scripts/tutorial/run.mjs --script ... --burn-cursor` additionally writes `recording-cursor.mp4`
next to `recording.mp4`: the same frames with a visible cursor (dark arrow with white edge) and a
pink click ring (about 600 ms, left press) burned in. Per frame the runner grabs twice after
`__vt.step`: first with the cursor hidden (-> `recording.mp4`), then with the DOM cursor shown at
the same pointer value that lands in `events.json pointer[]` (-> `recording-cursor.mp4`). The
virtual clock does not advance between the two grabs.

- Gate B, the trace checks, the motion check and the contact sheet run ONLY on the clean
  `recording.mp4` (Gate A on `stamp-proof.mp4` in proof mode); the cursor overlay sits below stamp
  and markers. In proof mode the stamp is hidden during both app grabs and shown only for the proof grab.
- After encoding both files must have the same decoded frame count, otherwise exit 1
  `burn-cursor-frame-mismatch`.
- Cost: about 2x grab time per frame plus a second encoder. Without the flag nothing changes.
