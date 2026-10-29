# Empty notebook lamp receiving

A valid notebook may contain zero trials. Before this repair, opening one after
a recorded investigation left the previous lamp classes, ON/OFF text, clamp
captions and accessible names visible. The notebook history was empty and its
budget was correctly restored, so the displayed result belonged to a different
investigation.

The empty-history branch of `renderLamps()` now clears both lamps' recorded
result classes and displays **NO RESULT** / **NO TRIAL RECORDED**. Each SVG's
accessible name explicitly says that no trial has been recorded in this
investigation. The nonempty-history rendering branch is unchanged.

## Repeat the focused browser check

Use Node 22 or newer, an installed Playwright ESM module and a Chrome/Chromium
executable. The receiver does not install software or contact a model provider.

```sh
node review/empty-notebook-browser.mjs \
  --app-root /absolute/path/to/equivia \
  --playwright /absolute/path/to/playwright/index.mjs \
  --browser /absolute/path/to/chrome \
  --out /absolute/path/to/new-receiving-directory
```

The output directory must not already exist. It receives a valid empty-notebook
fixture, `results.json` with named assertions and DOM/session observations,
and screenshots at 1440 and 375 pixel viewport widths. A zero exit status
requires all assertions to pass, with no page errors, console errors or blocked
external requests. The receiver permits only the supplied loopback origin,
disables service workers, uses a fresh browser context and closes resources it
owns. Its source-mode server receives an empty provider environment.

The same receiver accepts `--origin http://127.0.0.1:PORT` to exercise an
already-running extracted package. In that mode, `--app-root` must name the
extracted application directory. The caller owns launcher cleanup; the receiver
does not stop a server it did not start.

The 68 assertions cover initial startup's twelve recorded observations, valid
empty imports, clamped ON and clamped OFF results followed by empty imports,
persisted-empty reload, exact repeated-trial history and seed, full/restored
trial budgets, nonempty notebook restoration, passive observation and rejected
import preservation. The receiver records a failing baseline without stopping
after the first failed assertion.

## Recorded source receiving — 2026-10-29

| Observation | Source identity | Result |
| --- | --- | --- |
| Original application | Main `ebe07b6d76dbb992a34d3dac644bf53cd4e6072f` product source | 48/68 assertions passed; all 20 failures were empty-state visual/accessibility assertions. |
| Lamp reset candidate | Same base with only the empty-history rendering change | 68/68 passed. |
| Current-main composition | Based on `0533aca2b9f2b80ea280ab3652088264186f7448`, including the separately integrated manual creator worksheet | 68/68 passed; the worksheet change did not modify `public/app.js`. |

Original `public/app.js` SHA-256:
`c7e7fe2eebe0d51458c3945326781e8e3e68838f5a215a94eceed2f40be03a48`.

Patched `public/app.js` SHA-256:
`93df054b1b84d1e7bbff17f25e1be42c054a8a94f97c97d059d3e5df9702f2db`.

Receiver SHA-256:
`2215ddaeaca996a4200573580e21e1a60e07f8060757bb9b5d1edba379065b4a`.

The retained consumer reviewer authored and audited the receiver. The lead
executed it on the Linux build host through Renpō and inspected the desktop and
narrow screenshots. Product and coordination reviewers assessed brokered source
and result evidence; their reviews are not separate native executions. These
source results do not by themselves establish acceptance of a downloaded
release, Windows/macOS compatibility or other Linux distributions.

## Scope and continuity

This change does not modify session validation, storage/recovery, causal
inference, prediction scoring or platform launchers. The existing notebook
recovery, creator and platform owners retain their work. At startup the
coordination primary was unavailable; standby snapshot 5032 was read-only.
No new taskboard claim or writer promotion was made. The isolated worker/session
identities are `hamon-astra-2aaccdbb8940` /
`hamon-20261029-2aaccdbb8940`; pool check-in receipts are separate from
taskboard ownership. Native command receipts and original uncertain read handles
remain in the worker checkpoint. Package and release evidence should identify
their own exact source commit and archive hash.
