# Notebook import selection receiving

Notebook file opening must follow the learner's latest nonempty file selection.
An earlier read must not replace a newer selection or overwrite its status.

## Source and observed failure

Baseline: main commit `ebe07b6d76dbb992a34d3dac644bf53cd4e6072f`,
tree `ba8af4ec0a6474bf6d3bbad63519ed9a08f0cd87`.
Baseline `public/app.js` SHA-256:
`c7e7fe2eebe0d51458c3945326781e8e3e68838f5a215a94eceed2f40be03a48`.

The lead reproduced the failure in Chrome 156 using the notebook file input
and controlled native `Blob.text()` completion: select valid notebook A, select
valid notebook B, then resolve A before B. A opened and was saved; B was refused
because A had changed the investigation revision. There were no page errors or
external requests in that reproduction. This establishes an ordering failure;
it does not establish results for the proposed correction.

Baseline command: `estate-97f0802b-20261029-equivia-baseline-repro-01` (exit 0).
Receipt: `/home/ubuntu/hamon-work/estate-97f0802b-equivia-20261029/baseline-repro/receipt.json`.
Screenshot in the same directory: `obsolete-notebook-wins.png`.

## Integration base

The candidate will integrate onto newer main
`0533aca2b9f2b80ea280ab3652088264186f7448`, tree
`f45bbd2bf5b5acd2f7b5035a93a1a6ab496125f1`, preserving its concurrent local
world-pair builder. Its `public/app.js` blob remains
`dabcbf4c1404c780a2c5c47dd0ca4a39e0533432`; the notebook patch is unaffected.
The paired results below describe the earlier baseline and isolated candidate,
not verification of the combined integration tree. Combined package checks remain
pending and must include the newer assets and tests.

## Intended behavior

- Each actual, nonempty notebook selection supersedes pending older selections.
- Empty selection or file-picker cancellation does not supersede a pending read.
- A newer rejected file, including an oversized or invalid notebook, does not
  restore an older pending selection. The current investigation stays in place;
  the learner can select another file explicitly.
- Obsolete read completions and obsolete read errors leave the investigation
  and status unchanged.
- The existing revision check still protects edits or another investigation
  opened while the latest file is being read.
- Accepted files still pass executable replay validation before opening.

The proposed change adds only a notebook-selection generation check. It does
not change notebook schema, storage format, recovery copies, or persistence
rules. World-pair importing is a separate interaction and remains outside this
change's scope.

## Paired browser verification

The lead executed the independent receiver through Renpō on Linux with Chrome
156 and Chromium sandbox enabled. The same receiver ran against exact baseline
and candidate source. Baseline failed seven selection-order/status cases and
passed six preservation cases. Candidate passed all 13 cases, including both
completion orders, obsolete parse/read failures, invalid/failed/oversized newer
files, empty selection with a pending read, intervening edits/experiments/new
investigation, and preservation of unreadable saved text with autosave paused.
Both runs reported no page errors or unexpected requests, closed their browser,
and stopped their owned server with exit 0. Product implementation reviewed the
source and receipt; it did not independently execute these browser checks.

Candidate `public/app.js` SHA-256:
`919bebd0d014ac299f4f45acd300f87e7803dc398e322a1278e6746b68ab2d9a`.
Receiver SHA-256:
`d062adc63e277800ca971e8b8c1070638d87d538e87d928f568faed124348c3f`.
Proposed application patch SHA-256:
`1cffaad8aaad6dc5ffacbae6af8fde033fb39b1711f5f91f107c6d7c520dc852`.

Paired receipts under `/home/ubuntu/hamon-work/estate-97f0802b-equivia-20261029/`:
`receiver-baseline-01/notebook-receiver.json` and
`receiver-candidate-01/notebook-receiver.json`.

Receiver invocation (absolute paths required):

```sh
node review/notebook-import-browser.mjs APP_ROOT PLAYWRIGHT_MODULE CHROME OUTPUT_DIRECTORY
```

Requires Node.js, a separately installed Playwright ES module entry point, and
a Chrome executable supporting the enabled sandbox. The receiver starts its
own local app server, blocks external requests, and writes JSON plus screenshots
to OUTPUT_DIRECTORY. APP_ROOT is the checkout or extracted application root.

## Package verification

Package receiving remains pending. Run the maintained Linux packager (which
runs unit and HTTP checks on the extracted application),
extract the resulting archive, then run this receiver with the extracted app
root. Verify packaged app bytes match the reviewed candidate; exercise its
maintained launcher separately. A source-server browser pass does not establish
packaged-launcher operation or another platform's behavior.

Ownership and integration: this is an isolated correction to notebook opening,
not a claim on authored-world, forecast, lesson, or world-pair import work.
No merge, published release, or learner adoption is established by these checks.
