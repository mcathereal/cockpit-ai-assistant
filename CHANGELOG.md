# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

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

[1.0.1]: https://github.com/mcathereal/cockpit-ai-assistant/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mcathereal/cockpit-ai-assistant/releases/tag/v1.0.0
