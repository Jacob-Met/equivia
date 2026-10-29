# Authored proposal intent review

When two authored-world file reads completed out of order, an older valid file could replace the newer checked proposal and become the investigation actually adopted. An older invalid file could overwrite the newer success status. The correction tracks shared file/model intent, rejects obsolete completions, and invalidates pending proposal work when a visible proposal is adopted. Saving the currently visible checked pair remains a read-only action.

This is complementary repair and receiving work. The existing `hamon-auto11` authored-import ownership remains preserved; this note does not transfer that lane.

## Source and receiving evidence

- Initial isolated correction `public/app.js` SHA-256: `6da560e00a9f56e3af47993acd3cedaaa2ff97c179d5901c866592a71a9d4f48`.
- `review/authored-intent-browser.mjs` SHA-256: `6276c49c4746036e9eb362dd5dd02e5cd83ae1be90235ab584831a2c1073d686`.
- Lead executed through Renpō: `estate-4867de34-81a0-4be5-b126-558e315b3e4a-authored-intent-final-receiving-01`, exit 0 at `2026-10-29T20:36:59.841Z`.
- All 11 browser scenarios passed. There were no page errors, console errors, or unexpected requests. The owned browser and application CLI both exited 0. Native receiving directory: `authored-intent-candidate-final-01`.
- The initial corrected application candidate passed 78 native tests. Independent exact-source reviewers `implementation_review` and `consumer_verification` approved the correction.

The 11 cases cover stale valid completion and actual adoption; stale invalid status; stale model rejection; saving the visible pair while a new pair is pending; old completion before the latest pending file; latest invalid selection; canceled picker; explicit adoption while pending; repeated selection of the same filename; model then file; and file then model. Controlled file-read order makes the interleavings reproducible. Download receiving checks the saved title and worlds against the independently defined proposal and confirms the notebook stays unchanged.

The lead retrieved and visually inspected the 1440px and 390px screenshots. The proposal title and panel, action buttons, and main notebook remained readable without clipping. This is a specific rendered review, not a claim of universal accessibility.

## Failures retained

On base commit `57dd8ceb3ac2a7f61ca913abe8faf652b17d09d5`, baseline operation `estate-4867de34-81a0-4be5-b126-558e315b3e4a-authored-intent-baseline-01` exited 1 and demonstrated both genuine product failures: stale valid A replaced B and was actually adopted; stale invalid A overwrote B's status.

The first expanded receiving run, `estate-4867de34-81a0-4be5-b126-558e315b3e4a-authored-intent-verify-01`, exited 1: five cases passed, while two model interleaving cases failed in the harness because a string predicate wait violated the application's Content Security Policy. The final receiver uses bounded function-predicate polling and corrects the synthetic successful model response to include `ok: true`. Application CSP was not weakened. Those earlier results remain separate from the successful final run.

## Reproduce receiving

Use an available Playwright installation and a Chromium executable that supports the enabled sandbox. Choose a new output directory; the receiver refuses an existing directory.

```sh
node review/authored-intent-browser.mjs \
  --app-root /absolute/path/to/equivia \
  --playwright /absolute/path/to/playwright/index.mjs \
  --browser /absolute/path/to/chromium \
  --out /absolute/path/to/new-receiving-directory
```

The harness launches the actual application CLI on an ephemeral loopback port, controls its own sandboxed Chromium process, restricts browser requests, and retains lifecycle and receiving JSON, server output, downloaded world-pair evidence, and screenshots. Its bounded checks and cleanup apply only to processes it owns. Model interleavings use explicit local synthetic transport fixtures; no live provider or model quality is qualified by these results.

## Composition with current source

The correction is composed onto `73de31ef88d2eee15785c6ce97632c141b19bade`, preserving the merged worksheet-draft and seeing-versus-holding work. The composed application SHA-256 is `cc360dd09f784314160efb42b40e10e5d99c523b0142b0a9e9539a29584b2f29`. Its runtime diff remains confined to authored-proposal intent and the visible proposal actions; the new comparison and creator behavior are retained. The exact committed source identity and package verification are recorded by the maintained package builder in the delivered `BUILD.json` and its receiving evidence.
