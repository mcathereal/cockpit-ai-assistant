# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-09-28

### Added
- **MCP client in the plugin**: a new *MCP-Server (Werkzeuge von aussen)* section under **LLM-Profile** lets you register external MCP servers (Streamable-HTTP endpoint plus optional bearer token, kept in the browser only). Their tools are fetched with `tools/list` and offered to the model next to the 12 built-in host tools; calls run via `tools/call`. Everything goes through Cockpit's HTTP bridge, so no extra server component is needed on the Cockpit host for this direction.
- **MCP host tool server** (`tools/mcp-host-server.py`, Python standard library only): publishes the same host tools (virsh, journalctl, dmesg, df/free/uptime/ip, filtered `read_file`) to external MCP clients over Streamable HTTP (JSON-RPC 2.0, `Authorization: Bearer`). Read-only by default — the three write tools are only exposed with `AI_ASSISTANT_MCP_ALLOW_WRITE=1`. Ships with a ready-to-adapt systemd unit; the token lives in a `0600` root-only file.

## [1.2.0] - 2026-09-28

### Added
- **Turn-style transcript** (as in *MBM Call AI*): every line is a row with a role icon and a bold label (`Du:`, `Agent:`, `Tool:`, `Hinweis:`, `Fehler:`). Tool output is folded behind a `Tool: …` disclosure, so long command output no longer floods the chat.
- **Floating chat window**: the bottom-right button opens a small popup (`?widget=1`) that stays open while you navigate Cockpit and shares the same chats. The window has a compact header (open-in-cockpit + close).
- **Images for VL models**: attach pictures (button, paste, or drag & drop) and capture the current screen with the camera button. Images are sent as native OpenAI multimodal content parts (`image_url` with data URLs) straight to a vision-capable model — the same pattern the Qwen-MM-Plugins `core` plugin uses. Files are downscaled to max 1400 px before sending; the screenshot uses the browser screen-capture, which works best from the popup window.

### Changed
- Message bubbles restyled to the Call-AI turn layout (role colours, animated entrance, collapsible tool details).
- The bottom bar is a solid blurred toolbar now (text no longer bleeds through), the confirmation dialog got proper contrast, and the prompt box is more compact.

## [1.1.0] - 2026-09-28

### Changed
- **New UI in the MBM house style**, adopted from *MBM Call AI* (`mbm/call.ai`): shared design tokens as `R G B` triplets (`rgb(var(--t-*) / α)`), panel/line/accent palette for light **and** dark, a soft accent glow, and the Call-AI gradient/sweep header. Theme switching is now a single `data-theme` attribute on `<html>` (dark stays the default, so there is no light flash on load).
- **Cleaner, roomier layout**: sticky translucent top bar, 1080 px content column, section cards with soft shadow and a subtle entrance animation, message bubbles that fade/slide in, pill-shaped chat tabs and chips, stronger button variants.
- **Details moved behind icons and disclosures**: the top bar now carries icon-only controls (theme, settings, appearance, update). Inside *LLM-Profile*, key storage, model loading and sampling/per-tool checkboxes live in collapsible `Erweitert` sections.

### Added
- **Quick theme toggle** in the top bar (`#btnTheme`, sun/moon icons), stored with the existing appearance settings.

## [1.0.3] - 2026-09-10

### Fixed
- **LLM and update calls went out via SSH instead of HTTP**: `cockpit.http()` was called with the `host` option, which Cockpit's router interprets as a remote machine (spawning `ssh … port 22`), so every chat/model/update request died with `[Errno 110] ssh: connect to host … port 22`. Now uses the `address` option, which the bridge's HTTP channel connects to directly.
- **`tls: false` crashed the HTTP channel**: the bridge expects a dict for `tls`; anything else is a protocol error. For `http://` endpoints the `tls` key is now omitted entirely instead of being set to `false`.

### Changed
- **API keys persist across reboots**: key files moved from tmpfs (`/run/ai-assistant`) to `/var/lib/cockpit/ai-assistant-keys/<user>.json` (directory `0700`, file `0600`). No automatic migration — previously stored keys need to be entered once again.
- **Hardening**: removed `/usr/bin/sh` from `superuser.matches` — no code path spawns a shell.

## [1.0.2] - 2026-09-10

### Fixed
- **Sidebar entry never appeared / opened a blank page**: the manifest used `"menus"` with key `index.html`. Cockpit expects `menu`/`tools` (singular) and the shell appends `.html` itself, so the entry was invisible (`menus` is unknown to Cockpit) and the old key would have compiled to `ai-assistant/index.html.html` (404). Now a `tools` entry with key `index` (bottom section, order 1001), a robot emoji as icon (manifests support no icon field) and the GitHub link under the official `docs` key.
- **Stack overflow in the settings form**: `fillForm()` called `onLevelChange()` which called `fillForm()` back; with a `tools` array present (checkbox touched or new profile) the recursion never ended ("Maximum call stack size exceeded"). Added a re-entrancy guard.
- **Setup wizard overwrote the running installation**: the download+install steps (checked by default) re-cloned the repo over `/usr/share/cockpit/ai-assistant`, silently reverting local fixes. Both steps now log why they are disabled; package, cockpit-restart and Ollama steps still work.

### Security
- **Stricter CSP**: no `'unsafe-inline'` for scripts anymore (`script-src 'self'`); inline styles stay allowed (`style-src 'self' 'unsafe-inline'`, needed by `setup.html` and the mode badges). Added `connect-src 'self' ws: wss:` (Cockpit websocket transport), `object-src 'none'`, `base-uri 'self'`.
- **postMessage handshake hardened**: `agent.js` now checks `e.source` against the setup iframe window, and `setup.js` posts to the explicit same origin instead of `"*"`.
- **API-key directory**: `/run/ai-assistant` is now created with `mkdir -p` and locked to `0700` (key files `0600`). Before, a missing directory silently fell back to storing keys in browser localStorage.
- Session user name is HTML-escaped in the key-store hint.

## [1.0.1] - 2026-09-09

### Fixed
- **README encoding**: the file had been double-encoded (UTF-8 bytes read as CP850, then saved as UTF-8), which turned every umlaut and dash into mojibake. Repaired byte-exactly; all other files were verified to be clean and left untouched.
- **Syntax highlighting** in chat code blocks: escaping ran before the highlight regexes, so the quotes inside the injected `<span class="...">` attributes were matched again and mangled the rendered markup. Replaced by a per-line token scanner.

### Added
- **README screenshots**, generated from the real UI.
- **Screenshot tooling** (`tools/make-screenshots.ps1` + `tools/preview/cockpit-mock.js`): renders the actual plugin headlessly with only the Cockpit bridge replaced by fixed demo data. No Node, no build step, no Cockpit host needed.

### Changed
- **Icon in the installed UI**: the top bar and the floating button now use the neutral `icon-brain.svg` instead of the author's personal logo. The old `icon.svg` stays in the repository and is still used by the README and the screenshots; the preview mock swaps it back in so the pictures keep their look.

## [1.0.0] - 2026-09-09

First public release.

### Added
- **Guided setup dialog** (`setup.html` + `js/setup.js`): every step with a plain-language explanation, an opt-in checkbox and a Skip button. Nothing runs without an explicit checkmark. Re-openable later via "Setup starten".
- **Host tools with a strict allowlist**: 12 named functions (`vm_list`, `vm_info`, `vm_xml`, `vm_snapshots`, `vm_console_log`, `journal`, `host_status`, `dmesg`, `read_file`, `vm_start`, `vm_shutdown`, `vm_stop`) exposed to the LLM via OpenAI-compatible *function calling*. The model never sees a shell.
- **Four privilege levels**: `off`, `diagnose`, `advisory` (default), `act`. Granular per-tool checkboxes on top. Write tools (`vm_*`) always require a confirmation dialog with the exact command.
- **Multi-chat** with search, delete, and persistence (browser `localStorage`), auto-titled from the first question.
- **LLM profiles in the GUI**: base URL, model, optional key, temperature, `max_tokens`, `top_p`; "Load models" populates the model picker from `GET /models`. Works with Ollama, vLLM, OpenRouter, DeepSeek and any OpenAI-compatible endpoint.
- **API-key storage modes**: server-side tmpfs file per Linux login user (recommended, headless-friendly), browser fallback — never in HTML/JS.
- **Redaction**: base64 blobs, IPv4 addresses and `password=`/`token=`/`api_key=` lines are stripped from tool output *before* it is sent to the LLM.
- **Position & appearance settings**: fixed menu entry and/or floating chat tile (four corners), dark/light/auto theme, German/English/auto language. All stored per browser, applied instantly, no Cockpit restart.
- **Chat templates**: 10 built-in prompts (VM won't start, unreachable, network, performance, disk, guest agent, resize, snapshots, host check, distro-aware CoPilot mode).
- **Token estimates** per answer and a session total; typewriter rendering capped for long answers; minimal shell syntax highlighting in code blocks.
- **Update check** against the GitHub releases API (badge in the top bar).
- Full **German/English UI**, MBM Skyline dark theme as default plus light theme.

### Security
- `cockpit.spawn` exclusively with argv arrays — **no shell pipes, no `sh -c` at runtime**.
- Command allowlist declared in `manifest.json` (`superuser: "try"`, polkit/sudo only on declared paths).
- VM/unit/path arguments validated with strict regexes; file reads limited to a fixed prefix list; `..` rejected.
- Setup dialog's optional Ollama step downloads the install script to a temp file and executes that file (no `curl | sh` pipe).

## [0.9.0] - internal
- Multi-chat, update badge, token estimates, typewriter, syntax highlight (pre-release).

## [0.5.0] - internal
- First working agent loop, 4 levels, guided setup as iframe.

[1.3.0]: https://github.com/mcathereal/cockpit-ai-assistant/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/mcathereal/cockpit-ai-assistant/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mcathereal/cockpit-ai-assistant/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/mcathereal/cockpit-ai-assistant/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/mcathereal/cockpit-ai-assistant/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/mcathereal/cockpit-ai-assistant/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mcathereal/cockpit-ai-assistant/releases/tag/v1.0.0
