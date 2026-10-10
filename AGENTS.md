# Android Pi Agent

## Product constraints

- Personal, Android-hosted coding environment for Galaxy SM-S931Z (ARM64).
- `pi-durable` is the only agent backend. Do not launch a separate Pi CLI to compensate for missing mobile features.
- Follow `pi-tui`'s separation of components, input/focus, rendering, and lifecycle; Android rendering is DOM/touch/IME, not ANSI emulation.
- Base layout and interaction on ordinary Pi: flat transcript, thinking/tools, bottom editor and
  footer, slash commands. The owner chose a small, 16px `pi android client` label inside the
  scrolling transcript (not pinned, no command instructions). Selected model and thinking belong
  in that header as tappable selectors, not in the footer. Keep a composer with only editor and
  Send, and a separate settings page. Placeholder is exactly `...`. Ordinary send uses Steer;
  stop with `/abort` or Escape. Do not restore permanent command/menu/mode/stop bars or
  official-looking `pi` branding. Use mobile-specific controls where touch, IME or narrow
  screens need them; do not default to a generic web-chat design.
- Preserve targetSdk 28 and the proven app-private Termux executable layout. Play/general-distribution compatibility is not a requirement.
- Keep the reference repository and its uncommitted work intact. Never push its upstream.
- New package identity and storage are separate from `org.pimobile.app`. No implicit conversation or credential migration. The owner explicitly requested removal of the old Android app in checkpoint 5; it was removed from user 0 only. Preserve the host reference repository.

## Boundaries

- Durable conversations/documents are authoritative. UI state is limited to drafts, selection, expansion, and connection status.
- All conversation mutations carry an explicit conversation ID; abort bypasses the ordinary command queue.
- Never automatically retry submitted mutations after a transport failure. Reconnect by reading current durable state.
- Use standard coding tools and CLIs. The owner has authorized normal work on this project without repeated approval prompts: required package setup, builds/tests, data-preserving updates/restarts of the new Android app, and normal pushes to this repository's origin. This does not authorize deleting private data, exposing credentials, touching the reference app, or pushing upstream.
- Do not claim existing TUI extensions are automatically compatible with Android or durable. Track supported/adapted/unimplemented capabilities in `docs/capabilities.md`.

## Privacy and verification

- No credentials, private databases, screenshots, APKs, runtime archives or signing keys in git.
- Bridge tokens use request headers, never query strings. Local HTTP is authenticated and loopback-only.
- This is not isolation from code/tools running under the app UID.
- GitHub PATs belong only in the masked profile dialog/private store, never in model input, shell arguments, URLs or logs. Do not run gh auth token, dump the environment or inspect credential files.
- pi-pkg is additive only: no baseline/installed upgrades, overwrites or maintainer scripts. An interrupted package-install.lock requires inspection, never automatic deletion. Check it before APK updates.
- Preview uses a separate native process/WebView storage and owner-bound foreground requests. Never proxy the Main/auth WebView, replay browser mutations, capture private pages/input values, or install/launch a desktop browser on Android. Treat CDP scripts as trusted same-UID code, not a sandbox.
- Tests use temporary state and faux models; never discover the host's real Pi credentials.
- Distinguish host unit tests, desktop-browser checks, Android build success, device execution and real-provider inference.
- Keep setup read-only toward reference dependencies. Apply the standing project authorization above; do not ask again for routine steps.

## Development

- Keep code readable: one statement per line, multiline callbacks/methods, and blank lines between functions and logical phases (setup, validation, execution, rendering, cleanup). Do not compress code to minimize line count.
- Use two-space indentation for TS/JS/Java/HTML/CSS and four-space indentation for Python. Aim for 100-column lines; keep literal text unchanged when reformatting.
- Node >=22.19.0; native TypeScript type stripping, no transpilation for runtime code.
- `npm test`; `npm run check`; optional `PI_TEST_CHROME=/path/to/chrome npm test`.
- On-device updates use `adb install -r` after checking active work. Routine updates to the new app are pre-authorized; do not clear app data or update the reference app.
