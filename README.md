# M-Stream Bridge

[![Downloads](https://img.shields.io/github/downloads/Zielzy/M-Stream-Bridge/total.svg)](https://github.com/Zielzy/M-Stream-Bridge/releases)

M-Stream Bridge is a local companion tool for capturing non-DRM browser media streams, forwarding them to Migaku Player, and pairing playback with Jimaku subtitles.

## Features

- **Media Interception**: Automatically detects and captures HLS (`.m3u8`) and Direct (MP4) video streams from your browser.
- **Migaku Player Integration**: Seamlessly pipes unsupported video streams into Migaku Player via a local proxy, enabling advanced language learning tools.
- **Jimaku Subtitle Injection**: Integrates with the Jimaku API to automatically fetch and inject Japanese subtitles directly into the player.
- **Floating Console UI**: Provides an elegant, draggable control panel inside Migaku Player to easily switch between Direct/Proxy modes and manage subtitles.
- **Playback State Recovery**: Remembers your playback position and automatically restores it if the page is reloaded.
- **Local Dashboard**: A bundled local server dashboard (running on port 7000) to monitor stream status, configure API keys, and manage server settings.

## Included Files

- `extension/` - Chrome extension folder to be loaded unpacked.
- `server/MStreamBridge/M-Stream Bridge.exe` - local bridge server and default launcher.
- `migaku-player-snippet/migaku-player-snippet.js` - Chrome DevTools Snippet for Migaku Player.

## Setup
### Step 1 - Extension

1. Extract the release zip.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the `extension` folder from this release.
6. Pin the `extension`.
7. Run `server/MStreamBridge/M-Stream Bridge.exe`.
8. When the dashboard opens, save your own Jimaku API key if you want automatic subtitle lookup.

### Step 2 - Snippets

This step is manual because Chrome extensions cannot safely install DevTools Snippets for you.

1. Open Migaku Player.
2. Press `F12` to open Chrome DevTools.
3. Navigate to the **Sources** tab.
4. In the left-hand navigation pane, look for **Snippets**.
5. **If you don't see it**, click the double angle brackets (>>) to expand the hidden menu, then select **Snippets**.
<img width="288" height="178" alt="image" src="https://github.com/user-attachments/assets/84c677cd-0b5b-461d-a8bf-f267e238559e" />

6. Create a new snippet named `migaku-player-snippet`.
7. Open `migaku-player-snippet/migaku-player-snippet.js` in a text editor.
8. Copy the whole file into the new Chrome snippet.
9. Press `Ctrl+S` inside DevTools to save the snippet.

## Normal Use

1. Start the server with `server/MStreamBridge/M-Stream Bridge.exe`.
2. Open a supported non-DRM video page.
3. Let it play for about 5-10 seconds.
4. Open the extension popup and use Open Migaku.
5. Run the `migaku-player-snippet` snippet in Migaku Player.
6. Press `Proxy` or `Direct` to play (try `Proxy` first; if it doesn't play, use `Direct`).
7. Press `Jimaku` to inject subtitles.

## How to Run the `migaku-player-snippet`

Run this whenever Migaku Player needs the bridge UI again:

1. Open Migaku Player.
2. Press `F12`.
3. Press `Ctrl+P`.
4. Type `!`.
5. Select `migaku-player-snippet`.
6. Press `Enter`.

## Support Me

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/W4B71ZIEH5)

If you enjoy what I do, please consider supporting me. Thank you!

## ✨Tips
Use `CTRL + ALT + B` to fully hide the `migaku-player-snippet` UI.
