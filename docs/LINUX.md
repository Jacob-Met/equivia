# Run EQUIVIA on Linux x64

This private experimental portable build includes Node.js 22.23.4. A separate Node or npm installation is not required. It targets Linux x64 with GNU libc and uses your browser. Other architectures and musl-based distributions are unqualified. The receiving report records the operating system and browser actually exercised.

## Start and stop

1. Extract `equivia-0.1.0-linux-x64.tar.gz`. Keep the complete **EQUIVIA** folder together.
2. Open a terminal in that folder and run `./EQUIVIA.sh`.
3. Open the printed local address in your browser. The launcher does not open a browser automatically.
4. Keep the terminal open while using the laboratory. Press **Ctrl+C** there to stop its server. Closing the browser alone does not stop the server.

You can also run `/bin/sh "/path with spaces/EQUIVIA/EQUIVIA.sh"` from another working directory. The bundled runtime is selected by the package's location, independent of an installed Node.

Normal launches use http://127.0.0.1:4192 so the notebook stays in the same browser storage. If that address is occupied, the launcher reports the conflict and leaves the other process alone. It stops only its own server and does not install a service or change system settings.

For a separate concurrent session, run `./EQUIVIA.sh --temporary-port`. A temporary session uses a different origin, so use **Save notebook** before stopping, then **Open notebook** to resume later. Unknown or duplicate launcher options are rejected.

## Keep your investigation

Browser storage belongs to the browser profile and origin, not the extracted folder. Moving the complete package does not change the normal address. Use **Save notebook** for portable backups, particularly before changing browser profiles, origins or browser storage.

This package preserves the maintained application's behavior. Its separately tracked unreadable-notebook recovery issue is not repaired by the Linux launcher. Keep a portable backup of important investigations.

The laboratory, exact calculations and notebook work locally. The launcher starts with a clean environment; ambient `PORT`, `NODE_OPTIONS` and model configuration are not passed through. Optional NVIDIA/Nebius assistance is not configured, and no live model performance is qualified by these package checks.

## Source and integrity

`BUILD.json` identifies the exact source commit and tree, official runtime archive checksum, bundled executable checksum and maintained package checks. The top-level `SHA256SUMS` covers every payload except itself. `app/SHA256SUMS` is the maintained application manifest. On Linux, run `sha256sum --check SHA256SUMS` from the extracted EQUIVIA folder.

The full Node license and notices are in `runtime/LICENSE`; application rights are in `app/LICENSE`. This build preserves private development scope and does not grant public distribution rights.

## Rebuild

On a Linux x64 host with GNU libc, use a clean committed source checkout and obtain the pinned official runtime:

```sh
curl --fail --location --output node-v22.23.4-linux-x64.tar.gz \
  https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.gz
node tools/package-linux.mjs --runtime-archive /absolute/path/node-v22.23.4-linux-x64.tar.gz
```

The builder verifies the pinned archive checksum before extracting or executing the runtime. It reuses the maintained source allowlist and fresh-extraction tests, checks each application file against the committed source, includes the original licenses, verifies runtime dependencies and records exact identities. It does not publish the result.

Actual artifact receiving, with separately installed Playwright and Chrome, uses:

```sh
PLAYWRIGHT_MODULE=/absolute/path/playwright/index.mjs \
CHROME_EXECUTABLE=/absolute/path/google-chrome \
node review/linux-receiving.mjs ARCHIVE SHA256 SOURCE_COMMIT OUTPUT_DIRECTORY
```

The receiver checks the caller-pinned archive and committed source identity before launch. It requires the normal local port to be available, uses fresh browser storage and runs Chrome with its sandbox enabled. Its output distinguishes actual application behavior from a labeled timeout fixture. Inspect the saved screenshots as well as the interaction results.
