---
description: "Debug realvirtual WEB runtime state (signals, drives, errors)"
allowed-tools: Bash(*), WebFetch, Read, Grep, Glob
---

# Debug Command

Inspects and controls the running realvirtual WEB dev server (`localhost:5173`) via debug HTTP endpoints.

## Usage

```
/debug                           # Full state overview
/debug signals                   # All signal values
/debug drives                    # All drive states
/debug sensors                   # All sensor states
/debug errors                    # Browser console errors/warnings
/debug changelog                 # Recent signal changes with timestamps
/debug logic                     # Logic step tree with states
/debug transport                 # MU spawn/consume stats
/debug logs                      # All recent structured log entries
/debug logs warn                 # Only warnings and errors
/debug logs signal               # Only signal category logs
/debug watch Signal1,Signal2     # Watch specific signals only
/debug set SignalName true       # Set a boolean signal
/debug set SignalName 42.5       # Set a numeric signal
/debug jog DriveName forward     # Jog a drive forward
/debug stop DriveName            # Stop a drive
/debug move DriveName 90         # Move drive to position
```

## Prerequisites

The dev server must be running (`/dev` or `npm run dev`). A model must be loaded in the browser.

## Workflow

### READ operations (use WebFetch GET)

| Argument | Endpoint |
|----------|----------|
| *(none)* | `http://localhost:5173/__api/debug` |
| `signals` | `http://localhost:5173/__api/debug/signals` |
| `drives` | `http://localhost:5173/__api/debug/drives` |
| `sensors` | `http://localhost:5173/__api/debug/sensors` |
| `errors` | `http://localhost:5173/__api/debug/errors` |
| `changelog` | `http://localhost:5173/__api/debug/changelog` |
| `logic` | `http://localhost:5173/__api/debug/logic` |
| `transport` | `http://localhost:5173/__api/debug/transport` |
| `logs` | `http://localhost:5173/__api/debug/logs` |
| `logs <level>` | `http://localhost:5173/__api/debug/logs?level=LEVEL` |
| `watch A,B,C` | `http://localhost:5173/__api/debug/signals?names=A,B,C` |

Use `WebFetch` for all GET requests.

### WRITE operations (use Bash with curl POST)

**Set a signal:**
```bash
curl -s -X POST http://localhost:5173/__api/debug/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":"setSignal","name":"SIGNAL_NAME","value":VALUE}'
```

**Jog a drive:**
```bash
curl -s -X POST http://localhost:5173/__api/debug/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":"jogDrive","name":"DRIVE_NAME","forward":true}'
```

**Stop a drive:**
```bash
curl -s -X POST http://localhost:5173/__api/debug/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":"stopDrive","name":"DRIVE_NAME"}'
```

**Move a drive to position:**
```bash
curl -s -X POST http://localhost:5173/__api/debug/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":"moveDrive","name":"DRIVE_NAME","position":POSITION}'
```

After sending a write command, wait 1 second, then check results:
```bash
curl -s http://localhost:5173/__api/debug/cmd/results
```

### Presenting results

- **signals**: Table with Name and Value columns
- **drives**: Table with Name, Position, Speed, JogFwd, JogBwd, IsRunning
- **errors**: Chronological with level, timestamp, and message
- **write results**: Show success/failure status

### Error handling

- Connection error: dev server isn't running, suggest `/dev`
- `{"status":"no data yet"}`: no model loaded in the browser
