# M-Stream Bridge Extension

This folder is the Chrome extension folder used with Load unpacked.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this `extension` folder.
5. Start the local server with `M-Stream Bridge.exe`.

## What It Does

The extension captures browser media request events and page metadata, then sends them to the local server at `http://127.0.0.1:7000`.

Stream selection, title cleanup, Jimaku matching, and subtitle handling run in the local server package.
