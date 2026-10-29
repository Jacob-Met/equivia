# Run EQUIVIA on a Mac with Apple silicon

This private experimental portable build includes Node.js 22.23.4. A separate Node or npm installation is not required. It runs the laboratory locally in your browser.

## Start and stop

1. Extract the archive. Keep the complete **EQUIVIA** folder together.
2. Open Terminal, type `/bin/bash ` (including the trailing space), drag **EQUIVIA.command** into the Terminal window, and press Return.
3. The launcher opens the laboratory in your default browser. If it cannot open a browser, open the printed address yourself.
4. Keep the Terminal window open while using the laboratory. Press **Control+C** there to stop it.

You can also run `/bin/bash /path/to/EQUIVIA/EQUIVIA.command --no-browser` and open the printed address yourself. Paths may contain spaces; quote a path typed manually.

Normal launches use the maintained local address, http://127.0.0.1:4192, so the notebook stays in the same browser storage. If that address is already in use, the launcher reports the conflict and leaves the other process alone. The launcher stops only its own server. It does not install a service or change system settings. The portable folder is not a signed or notarized macOS application bundle; normal macOS launch controls apply.

## Keep your investigation

The normal address preserves the notebook in the same browser profile. Use **Save notebook** for a portable backup.

If the notebook saved in this browser fails validation, automatic saving pauses and the recovery panel preserves its original saved text. Use **Download original recovery copy** to keep that text as a repair file; it is not an ordinary notebook for **Open notebook**. You can continue working without overwriting the original and use **Save notebook** to keep your investigation as a portable file. Replacing the saved original requires **Back up and replace saved notebook**. Backups kept in browser storage share the original notebook's origin and quota, and can be lost if that storage is cleared.

For a separate concurrent session, add `--temporary-port`. That session uses a new address, so its browser storage is separate. Use **Save notebook** before stopping a temporary session, then **Open notebook** to resume it later.

The deterministic laboratory, exact calculations, and notebook work locally. This launcher starts with a clean environment and does not configure optional NVIDIA/Nebius assistance. Live model performance remains unqualified.

## Source and integrity

`BUILD.json` identifies the exact source commit, source tree, official runtime archive checksum, bundled executable checksum, and the maintained package checks. `SHA256SUMS` covers every packaged payload. `app/SHA256SUMS` is the maintained application manifest.

The runtime's full license and notices are retained in `runtime/LICENSE`; application rights are in `app/LICENSE`. This build preserves the private development scope. It does not grant public distribution rights.

## Rebuild from the maintained source

On a Mac with Apple silicon, use a clean committed checkout and obtain the pinned official runtime archive:

```sh
curl --fail --location --output node-v22.23.4-darwin-arm64.tar.gz \
  https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-arm64.tar.gz
node tools/package-macos.mjs --runtime-archive /absolute/path/node-v22.23.4-darwin-arm64.tar.gz
```

The builder verifies the official archive checksum before extracting or executing the runtime. It reuses the maintained application allowlist, checks a fresh source-package extraction, includes the original licenses, rejects non-system runtime dependencies, and records exact source and file identities. It does not publish the result.
