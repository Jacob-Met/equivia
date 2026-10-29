# Seeing and holding: executed receiving

## Source and attribution

This increment adopts the existing comparison draft by `estate-4c0dcfc3-0f50-4fb8-bf68-51ab1ed7da97`, recovered against maintained base commit `57dd8ceb3ac2a7f61ca913abe8faf652b17d09d5`. The draft author's workspace was read without modification. The receiving lead `estate-d0f95ce3-8a9f-464c-aa68-8376632345ae` added independent exact receiving, corrected inspector-selection coupling, and completed source/browser qualification.

The three retained reviewers independently assessed mathematical expectations, production source, and the rendered consumer experience. The lead executed the checks. Model-assisted product calls were not made.

## Verified source behavior — 2026-10-29

- All 83 native tests passed, with no skipped or failed tests.
- `review/observation-comparison-exact.mjs` passed independent literal-fraction checks. It does not use the product engine as an oracle.
- The actual local application passed 11 browser scenarios in sandboxed Chrome 156.0.8078.47 with its original Content Security Policy.
- The browser scenarios covered all four conditions, independent experiment/inspector controls, keyboard focus, notebook preservation and reopening, biased and noisy mechanisms, impossible observation, exhausted budgets, and revealed investigations.
- Layouts at 1440, 640, and 390 CSS pixels had no horizontal overflow. The lead and consumer reviewer inspected the desktop and phone inspector screenshots. The 640-pixel check is a reflow observation, not a claim of independently tested browser zoom.
- Recorded page errors, console errors, unexpected requests, and model POSTs were zero. Both owned browser and application processes exited gracefully.

The independent noisy fixture retains natural support 5/8 and gives a conditional probability of 2/5, whereas intervening leaves the other lamp's probability at 1/4. Its opposite observed value has support 3/8 and a valid conditional probability of zero. A separate impossible natural selection remains `zero_evidence` while its intervention remains meaningful.

## Preserved failures and correction

A browser negative control against the adopted draft failed because closing and reopening the comparison changed the inspected condition from B on to A on. The corrected application keeps the inspector's condition when trial controls change and when the panel is closed or reopened. Replacing the investigation initializes a new comparison choice.

The first post-correction browser run passed six scenarios, then an older Playwright `waitForFunction` implementation attempted string evaluation prohibited by the application's CSP. The receiver now polls the same exact storage and history predicates through its existing evaluation interface. Product CSP and browser sandbox settings were unchanged. The subsequent complete run passed all 11 scenarios. Both earlier results remain in the private receiving evidence.

## Reproduce

```sh
node --test test/*.test.*
node review/observation-comparison-exact.mjs
node review/observation-comparison-browser.mjs \
  --app-root /absolute/path/to/equivia \
  --playwright /absolute/path/to/playwright-core/index.mjs \
  --browser /absolute/path/to/google-chrome \
  --out /absolute/path/to/a-new-receiving-directory
node tools/package.mjs
```

The portable source packager uses an explicit runtime allowlist, hashes every included file, extracts the archive afresh, runs the extracted native tests, and starts the extracted CLI for HTTP receiving. The new comparison module is both explicitly packaged and explicitly served. Downloadable runtime builds must retain their exact commit and tree in `BUILD.json`; their platform-specific receiving and download hashes belong with the versioned release.

These results establish this finite-model implementation and the observed scripted experience. They do not establish educational efficacy, live model quality, or untested native platform support.
