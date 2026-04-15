# realvirtual WEB — Microsoft Teams App

## What This Is

A Teams app package that embeds the realvirtual WebViewer as a tab inside Microsoft Teams channels, chats, and meetings.

## Setup

### 1. Configure Bunny CDN Headers

In the Bunny CDN dashboard, add these response headers to your pull zone:

- **Header**: `Content-Security-Policy`
- **Value**: `frame-ancestors https://teams.microsoft.com https://*.microsoft.com https://*.skype.com`

This allows Teams to iframe your WebViewer. Without this header, Teams will show a blank page.

### 2. Build the App Package

Zip the three files in this directory:
```bash
cd teams-app
zip realvirtual-web-teams.zip manifest.json color.png outline.png
```

Or on Windows:
```powershell
Compress-Archive -Path manifest.json, color.png, outline.png -DestinationPath realvirtual-web-teams.zip
```

### 3. Install in Teams

**Option A — Sideload (development/small team):**
1. Open Microsoft Teams
2. Go to Apps → "Manage your apps" → "Upload an app"
3. Select "Upload a custom app"
4. Choose `realvirtual-web-teams.zip`

**Option B — Organization-wide (IT admin):**
1. Go to Teams Admin Center → Teams apps → Manage apps
2. Click "Upload new app"
3. Upload `realvirtual-web-teams.zip`
4. Optionally push to all users via Setup policies

### 4. Add to a Channel

1. Go to any Teams channel
2. Click **+** (Add a tab)
3. Search for "realvirtual WEB"
4. Configure the model URL (or use default)
5. Save — the 3D viewer loads inline

## How It Works

- The Teams app is just metadata (manifest + icons, ~50 KB)
- It tells Teams to load your Bunny-hosted WebViewer in an iframe
- The `?teams=1` URL parameter triggers the Teams JS SDK handshake
- `?lockSettings=true` hides the settings panel for a clean embedded experience
- The actual 3D viewer and models are served from Bunny CDN

## Who Can See It

| Deployment | Visibility |
|-----------|-----------|
| Sideloaded | Only you + anyone in channels where you add it |
| Admin-deployed | Everyone in your Microsoft 365 tenant |
| Teams App Store | Anyone with Microsoft Teams (requires Microsoft review) |

## Icons

- `color.png` (192x192) — Full-color app icon shown in Teams app catalog
- `outline.png` (32x32) — Monochrome outline icon for Teams navigation bar
  - For best results, this should be white-on-transparent
