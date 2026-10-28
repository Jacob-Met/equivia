# Run EQUIVIA on Windows x64

This private experimental portable build includes Node.js 22.23.4. A separate Node or npm installation is not required. The laboratory runs locally in your browser.

**Experimental qualification:** Native Windows build, launcher, local application, notebook reload, keyboard and layout checks passed. Exported-notebook file download/reimport and ordinary interactive default-browser opening remain unverified. In the automated SYSTEM session, both application export and a separate tiny Blob-download control emitted a download event without completing a file. The cause is unresolved. The release includes the passing checks and the failed/blocked receiving evidence; it does not claim full browser acceptance.

## Start and stop

1. Extract the ZIP completely. Keep the complete **EQUIVIA** folder together.
2. Open **EQUIVIA.cmd**. The launcher prints the local address and requests your default browser.
3. If a browser does not open, open the printed address yourself.
4. Keep the command window open while using the laboratory. Press **Enter in that window** to stop. Ctrl+C also requests shutdown.

Closing the command window terminates the local laboratory process. Closing only the browser tab does not stop it. This package does not install a service or modify system settings.

From an existing Command Prompt, you can run the quoted path followed by --no-browser and open the printed address yourself. For example:

    "C:\EQUIVIA\EQUIVIA.cmd" --no-browser

Normal launches always use http://127.0.0.1:4192. The same browser profile and address preserve the notebook's local storage. If that port is occupied, the launcher reports the conflict and leaves the existing process alone. It never silently moves your notebook to a new address.

## Keep your investigation

Use **Save notebook** for a portable backup. Use **Open notebook** to restore that file.

For a separate concurrent session, explicitly add --temporary-port. Its new address has separate browser storage. Save the notebook before stopping, then open the saved file at the next address.

The deterministic laboratory and exact calculations run locally. This launcher leaves optional NVIDIA/Nebius assistance unconfigured. It does not make cloud model requests. Engine, lesson, forecast and notebook behavior are the maintained application behavior.

## Source and integrity

BUILD.json identifies the exact source commit, source tree, official runtime archive and executable checksums, and actual package checks. SHA256SUMS covers every packaged payload; app/SHA256SUMS is the maintained application manifest. Runtime licenses and notices are in runtime/LICENSE. Application rights are in app/LICENSE.

This is an unsigned private development build. Native command-line and browser receiving are recorded with the release; a SYSTEM-account receiving run does not establish a personal interactive Explorer or default-browser launch. Normal Windows launch controls apply.

## Rebuild

On Windows x64, use a clean committed checkout. Obtain the official node-v22.23.4-win-x64.zip from https://nodejs.org/dist/v22.23.4/ and verify it against that release's SHASUMS256.txt. The builder independently checks the pinned archive digest before extracting or executing the runtime.

    node tools/package-windows.mjs --runtime-archive C:\Downloads\node-v22.23.4-win-x64.zip

The builder reuses the maintained source allowlist, runs the extracted application tests and HTTP checks with the bundled runtime, checks committed source bytes, includes original licenses, and verifies a fresh final ZIP extraction. It does not publish the result.
