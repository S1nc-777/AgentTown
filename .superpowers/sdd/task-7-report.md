# Task 7 Report: Electron independent-core spike

## Result

Task 7 produced a real Windows Electron spike, a standalone named-pipe core, an embedded terminal renderer, an unpacked Windows package, and measured evidence. The development runtime passes PTY streaming, input, resize, UI disconnect, core reconnect, explicit shutdown, and orphan cleanup. The packaged runtime builds and reaches terminal output, but its benchmark window does not exit within the bounded 10 second close window. This is recorded as the hard-gate blocker `packaged_window_exit_timeout`; `coreSurvivesUiExit` is therefore `false`.

## TDD evidence

- Initial survival RED: core process exited `1` because `src/core.ts` did not exist.
- Protocol RED: missing `protocol.ts`; runPty streaming RED: `onData` received no chunks.
- Protocol/core GREEN: 3 files, 8 tests; chunk framing, multiple messages, malformed continuation, unknown/invalid requests, ConPTY output, input, resize, disconnect, shutdown, and fake PID cleanup.
- Real Electron RED: missing main/preload/renderer and build artifacts.
- Real Electron GREEN: actual Electron 43.2.0 window received fake-Agent ConPTY output, exited `0` in the development path, core answered health after UI exit, and explicit shutdown exited the core `0`.
- Missing-core RED: Electron exited `1` with named-pipe `ENOENT` before detached launch existed.
- Missing-core GREEN: the bundled Node 24.14.0 runtime launches the core detached and produces real PTY output without an external Node dependency.
- Full development suite: 5 files, 12 tests passed; typecheck passed; process audit was empty.

## Packaging and measurements

- Locked versions: Electron 43.2.0, @electron/packager 20.0.3, esbuild 0.28.1, Node 24.14.0.
- Default Electron GitHub binary retrieval failed with HTTP 403/ECONNRESET. A single-command `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/` override succeeded; no global registry or Electron config was changed.
- `prune:true` was incompatible with the pnpm junction layout because packager could not locate `node-addon-api`. Packaging uses `prune:false` plus explicit excludes for development-only Electron, esbuild, and @electron dependencies.
- Final unpacked package: 521,177,511 bytes (497.03 MiB).
- The package contains `dist/node.exe`, `core.mjs`, `fake-agent.mjs`, and `node_modules/node-pty`.
- Packaged first-output observation: 798 ms.
- Packaged PTY output and embedded terminal: observed.
- Packaged UI close: failed bounded verification three times after output; no success was inferred.
- Final cleanup audit found no package-owned Electron, core, Node, or fake-Agent process.

## Files and boundary

- Electron main connects to an existing core or launches only the standalone core; it never imports `runPty` or the fake Agent.
- The core alone imports `runPty` and owns the PTY.
- Preload exposes only `health`, `startFake`, `sendInput`, `resize`, and `subscribeOutput`.
- Renderer appends raw terminal output with `textContent`; it never uses `innerHTML`.
- Task 8 and later work were not implemented.

## Independent review fix

- Extracted the Electron main-process pipe client into `core-client.ts` and added bounded pipe-open plus strict health-handshake validation before accepting an existing core.
- Only an initial `ENOENT` launches the detached core. Accepted-but-stale pipes, malformed/unhealthy health responses, connect timeouts, and `EACCES`/`EPERM` never launch a replacement.
- Missing-core startup retries are bounded by one total deadline. Every post-launch open and health wait recomputes and caps its timeout to the remaining deadline.
- Same-process callers for one pipe share a single connection/launch flight. Identity-guarded cleanup resets the flight after both success and failure, permitting later reconnect or retry.
- Socket timeout/error paths destroy the socket and remove temporary listeners; health failures close the client and clear pending request timers. Existing protocol tests continue to cover split chunks and multiple messages per chunk.
- Focused client tests: 10/10 passed. Real development existing-core and missing-core tests: 2/2 passed. Electron full suite: 22/22 passed.
- Full workspace tests and typechecks passed; Electron build and `pnpm probe:fake` passed; `git diff --check` passed; `ORPHAN_COUNT=0`.
- Packaged executable and packaging metrics were not rerun during this review fix. The existing `packaged_window_exit_timeout` blocker and `coreSurvivesUiExit: false` measurement remain unchanged.
- The backpressure Minor was intentionally not implemented.
