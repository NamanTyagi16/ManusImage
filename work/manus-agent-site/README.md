# Manus AI Unlimited • Multi-Key Agent Console

A redesigned, high-performance console for Manus AI with multi-key pooling, background chat spawning, public share link generation, and persistent conversation history.

## Features

- **Multi-API Key Pool ("Unlimited")**: Add and manage multiple Manus API keys directly from the UI or `.env`. Automatic round-robin load-balancing, live quota monitoring, and credit tracking.
- **Flexible Chat Routing**: Choose per-prompt whether to **"Continue Current Chat"** (appends instruction via `task.sendMessage`) or **"Start as New Background Chat"** (spawns an independent cloud task via `task.create`).
- **Automatic Public Chat URLs**: Tasks are configured with `share_visibility: "public"`. When tasks finish running, the official public share link (`https://manus.im/share/...`) is automatically surfaced with instant copy and open actions.
- **Full History Persistence**: Chats, messages, attachments, and assigned keys are saved across restarts in `data/chats.json` and `data/keys.json`.
- **Modern UI / UX**: Complete visual redesign with dark/light theme support, responsive typography, Markdown formatting with syntax highlighting, and smooth asynchronous polling.

## Quick Start

1. Start the server:
   ```bash
   npm run dev
   # Or on Windows, double-click start-server.bat
   ```

2. Open your browser:
   ```
   http://127.0.0.1:5188
   ```

3. Manage your keys:
   - Click **"Keys ⚙"** or **"API Keys Pool"** in the sidebar.
   - Add any number of Manus API keys (`sk-...`). Each key is tested live against the Manus API and tracked for credits.
