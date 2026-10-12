# Browser recording via MCP

Records the full visible realvirtual WEB page: 3D scene, toolbars, panels and dialogs.
The recorder owns a dedicated headless Chromium page. Every recording action targets
that page. It uses a fresh browser profile for each session.

Recording pages automatically close the **ENTWICKLUNGSSERVER** banner whenever
it appears, including after navigation. Normal browsing keeps its usual banner behavior.
They also start with the welcome/terms modal already accepted (`rv-terms-accepted`,
`rv-welcome-dismissed` in localStorage), so a fresh recording profile opens straight into the scene.

## Setup

From the WebViewer directory:

```powershell
npm.cmd install
node node_modules/playwright/cli.js install chromium
```

Register this local stdio MCP companion in your client's configuration. Replace the
path with your checkout's absolute path; the server does not depend on its working directory.

```json
{
  "mcpServers": {
    "realvirtual-recording": {
      "command": "node",
      "args": ["/absolute/path/to/realvirtual-WebViewer~/scripts/recording/server.mjs"]
    }
  }
}
```

The companion owns `recording_*`. CONNECT retains ownership of `web_*`; no existing
MCP configuration is changed by installing this code. This first version controls
the recorded page through browser input. It does not forward CONNECT commands or
assume that CONNECT has selected this browser among other connected tabs.

## Tools

| Tool | Purpose |
| --- | --- |
| `recording_start` | Open `url` and record at `width` × `height` (default 1920 × 1080). |
| `recording_snapshot` | Return a full viewport PNG and accessibility tree for choosing selectors. |
| `recording_run` | Run ordered `steps`: `click`, `doubleClick`, `fill`, `press`, `drag`, `wheel`, `waitFor`, `wait`. |
| `recording_status` | Report recording state, elapsed time and artifact paths. |
| `recording_stop` | Close the page and finalize the WebM file. Safe to repeat. |

Use unique Playwright selectors, such as `button[aria-label="Settings"]`. Ambiguous
matches fail. Drag coordinates use viewport pixels. A drag animates over `durationMs`.
Use `waitFor` for readiness and `wait` for deliberate pacing; a failed step stops its
sequence and returns an MCP error. Recording continues so you can inspect or stop it.
Keep batches below your MCP client's request timeout.

Recording starts before navigation, so loading and time between tool calls are included.
The automatic stop defaults to 180 seconds after initial navigation completes
(`maxDurationSec`, 10–1800). Navigation has a separate 60-second timeout.
Client disconnection also attempts to finalize the video. Killing the process forcibly
or a browser crash can prevent finalization.

## Run a recipe

Start your application separately, then:

```powershell
node scripts/recording/run.mjs http://127.0.0.1:5173/ scripts/recording/demo.json
```

The runner launches the companion and calls it through the MCP SDK. Recipes contain
optional `recording` options and a `batches` array of step arrays. The runner always
calls stop, including when a step fails, and exits unsuccessfully on failed actions.

Output defaults to `test-results/recordings/<unique-session>/`:

- `*.webm`: playable viewport video.
- `final.png`: last visible page, when capture succeeds.
- `accessibility.txt`: final UI tree, when available.
- `session.json`: options, timestamps, action results and page errors.

`outputDir` overrides the output root. Recordings are generated artifacts and are
excluded from version control by the existing `test-results/` rule.

This captures the visible page only, excluding browser chrome, other tabs, native OS
dialogs and audio. Frame rate depends on Playwright and rendering performance; it is
not a guaranteed 60 fps capture. WebM is the native output. If FFmpeg is installed,
convert a finished recording to MP4 with:

```powershell
ffmpeg -i recording.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart recording.mp4
```

Camera MCP tools in realvirtual WEB move the separate AI eye. Use a `drag` action
with `button: "right"` to orbit the visible camera for a video (left drag selects).

The included demo recipe opens the welcome page's demo link, waits for the model,
uses Space twice to pause and resume the simulation, orbits the visible camera,
and opens the Drives panel. It expects the standard English demo UI. Adapt selectors
for other versions or projects using `recording_snapshot`.

For the internal ribbon slitter demo (requires the private Development project), use:

```powershell
node scripts/recording/run.mjs 'http://127.0.0.1:5173/?projectUrl=http://127.0.0.1:5173/private-assets/Development/&doc=doc_models-demoribbonslitter-glb_1e0sl6w&mode=hmi' scripts/recording/ribbon-demo.json
```

This recipe frames the model, orbits slowly, displays measurements, demonstrates a
brake fault and resets the line. Opening the project explicitly also loads its
Ribbon Tension panel. `wheel` steps use `x`, `y` and `deltaY`; the wheel zooms toward the middle of the
view unless the viewer's *Zoom to mouse cursor* setting is on, then toward `x`, `y`.

Use `ribbon-max-tension.json` with the same URL for a tighter view with the dancer
load set to the control's maximum of **200 N** and measurements visible throughout.

The recorder uses Playwright's full Chromium in new headless mode, which supports
the normal browser rendering path. GPU availability still depends on the host.
See [Playwright browser modes](https://playwright.dev/docs/browsers#chromium-new-headless-mode)
and [video recording](https://playwright.dev/docs/videos).

## Verification

```powershell
node --test scripts/recording/recording.test.mjs
```

The integration test exercises the actual stdio MCP server, validates error handling,
opens a properties panel and decodes the resulting video in Chromium to check size
and duration. It uses its own local HTTP fixture and leaves existing browser sessions alone.
