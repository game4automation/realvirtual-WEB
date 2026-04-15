# Microsoft Teams App Manifest

This directory contains the manifest for distributing realvirtual WEB as a Microsoft Teams personal tab.

## Files

- `manifest.json` — Teams app manifest (edit placeholders before uploading)
- `color.png` — Required: 192×192 px full-color app icon (PNG with transparency)
- `outline.png` — Required: 32×32 px monochrome outline icon (PNG, white on transparent)

## Icon Requirements

The two icon files are **not included** and must be created before the manifest can be uploaded to Teams.

| File | Size | Format | Content |
|------|------|--------|---------|
| `color.png` | 192×192 px | PNG (transparency allowed) | Full-color realvirtual logo or branded icon |
| `outline.png` | 32×32 px | PNG (white on transparent) | Simplified single-color outline version |

See [Microsoft's icon guidelines](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/apps-package#app-icons) for exact requirements.

## Setup Steps

1. **Replace placeholders** in `manifest.json`:
   - `{{MICROSOFT_APP_ID}}` — Generate a GUID (e.g. `uuidgen` or https://www.uuidgenerator.net/)
   - `{{YOUR_DOMAIN}}` — Your deployment domain (e.g. `viewer.acme.com`)

2. **Create icons** (`color.png` and `outline.png`) and place them in this directory.

3. **Package the app**:
   ```bash
   cd teams-manifest
   zip -r realvirtual-teams.zip manifest.json color.png outline.png
   ```

4. **Upload to Teams**:
   - Go to Teams → Apps → Manage your apps → Upload an app
   - Select `realvirtual-teams.zip`
   - The 3D Viewer tab will appear in personal apps

## Multiuser Collaboration in Teams

When the viewer is opened inside Teams, the multiuser feature works as normal:

1. Each team member opens the 3D Viewer tab
2. Click the Multiuser button in the top bar
3. Enter the server URL (the `MultiplayerWEB` Unity server address) and a display name
4. Team members appear as colored avatar spheres in each other's views

For shared sessions within a Teams meeting, use the URL join parameter so all participants connect to the same server automatically:

```
https://{{YOUR_DOMAIN}}/webviewer?context=teams&server=ws://192.168.1.5:7000&name={{TeamsUserName}}
```
