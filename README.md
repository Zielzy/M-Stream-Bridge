<p align="center">
  <img src="https://github.com/user-attachments/assets/000c078a-0680-4fc2-b40c-020f06882b53" width="450">
</p>

<h1 align="center">M-Stream Bridge</h1>

<p align="center">
  <a href="https://github.com/Zielzy/M-Stream-Bridge/releases">
    <img src="https://img.shields.io/github/downloads/Zielzy/M-Stream-Bridge/total.svg">
  </a>
  <a href="https://ko-fi.com/Zielzy">
    <img src="https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi">
  </a>
</p>

<p align="center">
  A companion tool that expands Migaku Player support to many more non-DRM streaming websites via a local proxy. Includes Jimaku API integration for quick subtitle fetching.
</p>

## Features

- **Media Interception**: Automatically detects and captures HLS (`.m3u8`) and Direct (MP4) video streams from your browser.
- **Migaku Video Player Integration**: Seamlessly pipes unsupported video streams into Migaku Player via a local proxy, enabling advanced language learning tools.
- **Jimaku Subtitle Injection**: Integrates with the Jimaku API to automatically fetch and inject Japanese subtitles directly into the player.
- **Floating Console UI**: Provides an elegant, draggable control panel inside Migaku Player to easily switch between Direct/Proxy modes and manage subtitles.
- **Playback State Recovery**: Remembers your playback position and automatically restores it if the page is reloaded.
- **Local Dashboard**: A bundled local server dashboard (running on port 7000) to monitor stream status, configure API keys, and manage server settings.

## How It Works

M-Stream Bridge coordinates three main layers to bridge browser media into Migaku:

1. **Interception**: When you play a video in your browser, the **Chrome Extension** intercepts the stream requests (HLS playlists or Direct video links) along with their network authorization headers (Cookies, User-Agents, Referers) and sends them to the local server.
2. **Local Proxying**: The local **Server** receives the stream. Since media servers usually protect streams against hotlinking and CORS, the server acts as a local proxy, forwarding the video chunks while attaching the original browser headers to bypass authorization checks.
3. **Injected Integration**: Inside Migaku Player, the **DevTools Snippet** renders a floating control bar. It feeds Migaku a dummy video to pass initial drag-and-drop checks, then instantly swaps the video source with the local proxied stream URL, while injecting subtitle tracks fetched from the **Jimaku API**.

<div align="center">

<table>
<tr>
<td>
<img src="https://github.com/user-attachments/assets/fdb9cd58-f7aa-4886-b511-10bd7bb62e78" width="400">
</td>
<td>
<img src="https://github.com/user-attachments/assets/6bbdeb52-8356-4e00-97bc-85fb634cb2ef" width="400">
</td>
</tr>
</table>

</div>

## Included Files

- `extension/` - Chrome extension folder to be loaded unpacked.
- `M-Stream Bridge.exe` - local bridge server and default launcher.
- `migaku-player-snippet.js` - Chrome DevTools Snippet for Migaku Player.

## Setup
### Step #1 - Extension

1. Extract the release zip.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the `extension` folder from this release.
6. Pin the `extension`.
7. Run `M-Stream Bridge.exe`.
8. When the dashboard opens, save your own Jimaku API key if you want automatic subtitle lookup.

### Step #2 - Snippets

This step is manual because Chrome extensions cannot safely install DevTools Snippets for you.

1. Open Migaku Player.
2. Press `F12` to open Chrome DevTools.
3. Navigate to the **Sources** tab.
4. In the left-hand navigation pane, look for **Snippets**.
5. **If you don't see it**, click the double angle brackets (>>) to expand the hidden menu, then select **Snippets**.
<img width="288" height="178" alt="image" src="https://github.com/user-attachments/assets/84c677cd-0b5b-461d-a8bf-f267e238559e" />

6. Create a new snippet named `migaku-player-snippet`.
7. Open `migaku-player-snippet.js` in a text editor.
8. Copy the whole file `Ctrl+A` into the new Chrome snippet.
9. Press `Ctrl+S` inside DevTools to save the snippet.

## Normal Use

1. Start the server with `M-Stream Bridge.exe`.
2. Open a supported non-DRM video page.
3. Let it play for about 5-10 seconds.
4. Open the extension popup and use Open Migaku Player.
5. Run the `migaku-player-snippet` snippet in Migaku Player.
6. Press `Proxy` or `Direct` to play the stream (`Proxy` is recommended first). If it doesn't work, press `Retry` then `Direct`. If neither works, the stream is likely protected by strict DRM or site protection, try another server)
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

If you find this project useful, you can support me on Ko-fi ☕

## Tips
Use `CTRL + ALT + B` to fully hide the `migaku-player-snippet` UI.
