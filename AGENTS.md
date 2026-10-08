# Android Pi Agent

## Product constraints

- Personal, Android-hosted coding environment for Galaxy SM-S931Z (ARM64).
- `pi-durable` is the only agent backend. Do not launch a separate Pi CLI to compensate for missing mobile features.
- Follow `pi-tui`'s separation of components, input/focus, rendering, and lifecycle; Android rendering is DOM/touch/IME, not ANSI emulation.
- Preserve targetSdk 28 and the proven app-private Termux executable layout. Play/general-distribution compatibility is not a requirement.
- Keep the reference repository and its uncommitted work intact. Never push its upstream.
- New package identity and storage are separate from `org.pimobile.app`. No implicit conversation or credential migration.

## Boundaries

- Durable conversations/documents are authoritative. UI state is limited to drafts, selection, expansion, and connection status.
- All conversation mutations carry an explicit conversation ID; abort bypasses the ordinary command queue.
- Never automatically retry submitted mutations after a transport failure. Reconnect by reading current durable state.
- Use standard coding tools and CLIs. Package installation, remote writes/pushes, APK installation and privileged Android changes require approval.
- Do not claim existing TUI extensions are automatically compatible with Android or durable. Track supported/adapted/unimplemented capabilities in `docs/capabilities.md`.

## Privacy and verification

- No credentials, private databases, screenshots, APKs, runtime archives or signing keys in git.
- Bridge tokens use request headers, never query strings. Local HTTP is authenticated and loopback-only.
- This is not isolation from code/tools running under the app UID.
- Tests use temporary state and faux models; never discover the host's real Pi credentials.
- Distinguish host unit tests, desktop-browser checks, Android build success, device execution and real-provider inference.
- Keep setup read-only toward reference dependencies. Install packages and push only with approval.

## Development

- Keep code readable: one statement per line, multiline callbacks/methods, and blank lines between functions and logical phases (setup, validation, execution, rendering, cleanup). Do not compress code to minimize line count.
- Use two-space indentation for TS/JS/Java/HTML/CSS and four-space indentation for Python. Aim for 100-column lines; keep literal text unchanged when reformatting.
- Node >=22.19.0; native TypeScript type stripping, no transpilation for runtime code.
- `npm test`; `npm run check`; optional `PI_TEST_CHROME=/path/to/chrome npm test`.
- On-device updates use `adb install -r` only after checking active work and obtaining approval. Do not clear app data.
