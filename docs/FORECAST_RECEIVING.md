# Current-run forecast receiving

## Scope

This increment connects a learner's committed estimate to exact before-run and revised next-trial forecasts. It adds no notebook fields, historical batch reconstruction, new lesson, engine behavior or provider behavior. The primary EQUIVIA owner remains hamon-3d852f14; this is complementary assistance recorded in [hamon#1631 coordination comment](https://github.com/Jacob-Met/hamon/issues/1631#issuecomment-6488142766) and native task equivia-current-run-forecast-3dcd9e8b.

## Executed evidence

The lead executed checks through Renpo. The retained source worker authored and reviewed the pure helper; the pool worker independently authored sequence-enumeration references and browser receiving; the source worker independently reviewed the lead's UI/static-asset diff. Root inspected the actual screenshots. Workers reviewed brokered source and evidence; they did not independently execute host commands.

- Mac arm64, Node 22.23.4: 66 unit tests passed, including 12 new forecast cases. Independent sequence enumeration covers noisy and deterministic candidates, unequal posterior weights, impossible evidence, order invariance, pure inputs and fixed-world batch predictions. A reference typo 59/68 was corrected to 43/68 before execution.
- Actual CLI: 13 HTTP checks passed, including the newly served forecast module and withholding the server-only provider module.
- Fresh source archive extraction: 66 unit tests and 13 CLI/HTTP checks passed. That early candidate archive preceded the browser harness and this receiving document; it does not identify the final release artifact.
- Actual sandbox-requested Chrome 156.0.8078.48: 10 browser receiving cases passed. Keyboard estimate entry; one-trial exact reflection; control-change immutability; reload without reconstructed history; valid import followed by a new conditioned forecast; invalid import preservation; reset; three-trial count distribution and responsive layout; a second batch; explicit exhausted-budget rejection retaining the last result.
- The browser observed 24 requests, all within its allowed local origin, no page/console errors and only expected root-page navigations. The server process removed documented provider configuration; no live model qualification is claimed.
- Root visually inspected the 1440px and 375px result screenshots: single-trial metrics, exact fractions, whole-run count labels and observed marker remain readable and unclipped. The narrow count grid uses two columns. Keyboard focus was visible in the inspected focus screenshot. This is a bounded visual review, not a universal accessibility or learning-efficacy result.
- Successful receiving browser PID 25409 and server PID 25405 both exited 0; the server received the owned SIGINT cleanup. There was no forced browser cleanup.

## Preserved failures and limits

The initial Linux run passed 63 of 66 tests. All three failures were existing entrypoint checks expecting 12 HTTP checks after the added module increased the count to 13. Those expectations were corrected without removing route checks. A Linux rerun stopped at a 32 MB disk guard before testing; verification continued in an isolated Mac workspace.

The first browser attempt (browser07) passed keyboard entry but timed out after the first normal click while Playwright waited for scheduled navigation. Browser close confirmation also timed out; its server exited 0. A later read-only process survey found the recorded processes absent and no matching native headless Chrome process. This remains a failed attempt, not a graceful-close success. The next attempt retained a BrowserServer process handle, journaled lifecycle state, used normal actionable clicks without a navigation wait followed by unchanged exact UI assertions, and used bounded cleanup. Several harness conditions changed together; no unique root cause is established.

This receiving record binds the runtime files below. It precedes downloadable runnable-release qualification, which must verify the final committed package, downloaded bytes and launcher path separately. Existing Mac.2, Linux.2 and Windows.1 artifacts are unchanged and do not contain this feature. Windows browser-download diagnosis and live NVIDIA/Nebius qualification remain separate unresolved outcomes.

## Runtime file identities

- Base source:fd9abefd25cd338fcdd6501b093141b74b2426ca
- public/app.js:c7e7fe2eebe0d51458c3945326781e8e3e68838f5a215a94eceed2f40be03a48
- src/forecast.js:626448ac12459708056de2c5cbdb01dca8d9f8e8cb847814f2db7f7aa368481f
- test/forecast.test.mjs:b54525f8d72400209ce833595e01d1c0e89505d0def5c7e4a1f1e36228824d22
- public/styles.css:95f648b0fc4381dc103fa94f88bbc6724e1f3102c1f4b3858903a020d2ec717b
- review/forecast-browser.mjs:7474dfbfe01e7cca5bcfe5cbd21fb515cee097eb4971e588a5b5bced8f6b194d

Run the focused browser receiver with the exact app root, installed Playwright ESM file, a Chrome executable and a new output directory whose parent already exists:

```sh
node review/forecast-browser.mjs --app-root /path/to/equivia --playwright /path/to/playwright/index.mjs --browser /path/to/chrome --out /path/to/new-receiving
```

A successful source receiver does not by itself qualify a platform archive. Retain its JSON, lifecycle record, screenshots and exit receipts alongside platform receiving evidence.
