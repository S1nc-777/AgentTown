# Task 8 Report: Tauri/Rust independent-core spike

## Result

Task 8 is blocked before the required survival-test RED because the official Rust toolchain could not be installed in the bounded environment window. No Tauri/Rust implementation was created and no runtime, PTY, reconnect, packaging, size, or cold-start success is claimed. All four hard gates are therefore `false` in `framework-tauri.json`.

## Environment audit

- `rustc`, `cargo`, and `rustup` were initially absent from `PATH`.
- Visual Studio Community 2022 17.13.35825.156 is installed. `vcvars64.bat` activates MSVC 19.43.34808 x64 and Windows SDK 10.0.22621.0.
- WebView2 Runtime 150.0.4078.83 is installed.
- Node 24.14.0 and pnpm 11.9.0 are available.
- `cargo-tauri` was not installed.

## Official rustup installation evidence

1. Downloaded `rustup-init.exe` from `https://win.rustup.rs/x86_64`.
2. The Windows Authenticode status was `NotSigned`, so the executable was not trusted on signature alone.
3. Downloaded the official checksum from `https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe.sha256`. The downloaded executable matched the published SHA-256 exactly. Its size was 12,814,336 bytes.
4. Running the verified executable under a renamed filename failed with `unknown proxy name`; rustup dispatches from its executable name.
5. Running the same verified bytes as `rustup-init.exe -y --profile minimal --default-toolchain stable` made partial progress but exceeded a bounded 184-second attempt. Its exact process identity was checked before termination.
6. A final explicitly authorized retry used rustup 1.29.0 with only the official endpoints `https://static.rust-lang.org` and `https://static.rust-lang.org/rustup`: `rustup toolchain install stable --profile minimal --force`.
7. The retry grew the partial toolchain from 48 files / 43,012,724 bytes to 94 files / 159,694,066 bytes, then made no console or filesystem progress for more than five minutes. Buffered output after termination showed it had stalled at `downloading 6 components`.
8. PID 22196 and its exact command line were verified before force termination. The final audit found zero rustup processes.

## Final toolchain state

- rustup: 1.29.0 (28d1352db 2026-03-05)
- host: `x86_64-pc-windows-msvc`
- default/active toolchain: none
- stable payload: incomplete (`cargo.exe` payload present, `rustc.exe` payload absent)
- `rustc --version`: unavailable through the rustup proxy
- `cargo --version`: unavailable through the rustup proxy

The toolchain cannot compile even a failing Rust test. Writing the planned `TestCore`, `portable-pty` server, Tauri client, or package configuration without ever compiling it would create unverified and potentially misleading source, so those files were deliberately not created.

## Measurements

- Implementation time: 15 minutes of bounded prerequisite audit/install work.
- Package size: not measured; no package exists. The schema-required numeric placeholder is `0`, and `packageBuilds: false` prevents it from being interpreted as a successful measurement.
- Cold start: not measured; no executable exists. The schema-required numeric placeholder is `0`, and all runtime gates are false.
- Locked Rust/crate/Tauri versions: unavailable because dependency resolution could not begin.
- Final blocker: `rust_toolchain_download_stalled`.

## Boundary

No Task 9 or later work was implemented. No mirror, elevated installer, alternative toolchain manager, or unrelated global configuration was used.
