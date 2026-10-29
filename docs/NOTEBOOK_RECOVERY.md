# Original notebook recovery

This work preserves the original contribution from `hamon-auto11-20261027/equivia-recovery`, tracked in [issue #1](https://github.com/Jacob-Met/equivia/issues/1). Its original app, HTML and CSS baseline matches commit `4e77f4c4c8a1662d123ae44d353193ca91830982`. The preserved candidate app is SHA-256 `8ae3528a3ece1fb8bfbe9f1a0c71e6fdf8cb4f6259f58a7fbceb9800ea966b4f`.

The contribution pauses automatic writes while a known unreadable notebook is retained. Explicit replacement validates the current investigation, creates or reuses one of eight separate browser recovery keys, reads that copy back, rechecks the main saved text, then attempts replacement. Existing copies are not evicted.

Independent receiving found three additional failures: a failed initial read followed by working writes could overwrite unseen saved data; direct UTF-8 Blob export could alter lone UTF-16 surrogates; and a successful write followed by failed readback could be labeled “not replaced.” The bounded corrections preserve an explicit read-failure pause, use a reversible JSON recovery envelope, and retain an unverified replacement state without another automatic attempt.

## Recovery file

A recovery file has exactly three fields:

```json
{
  "schema": "equivia.saved-notebook-recovery.v1",
  "storageKey": "equivia.notebook.v1",
  "storedText": "the exact saved DOMString"
}
```

Parsing JSON preserves the original JavaScript string, including lone surrogate code units. This is a repair container, not an ordinary notebook import. Ordinary notebook serialization and executable replay validation are unchanged.

Separate browser keys share the same profile, origin, quota and clearing risks. Their readback is evidence at that moment, not an independently durable disk backup. Rechecking the main key before writing detects observed intervening changes; localStorage does not provide an atomic compare-and-swap across tabs.

## Receive the actual application

Use a separately installed Playwright and sandbox-capable Chrome. No model call is needed:

```sh
PLAYWRIGHT_MODULE=/absolute/path/playwright/index.mjs \
CHROME_EXECUTABLE=/absolute/path/google-chrome \
node review/recovery-receiving.mjs /absolute/path/source-or-extracted-app /absolute/path/output
```

The receiver starts the supplied app's actual Node CLI on loopback with model configuration absent, verifies the served app hash, and uses a fresh browser context for each case. It checks ordinary intervention and keyboard recovery, actual downloads, successful replacement/reload and retained-copy download, initial read failure before edits or valid import, unusual UTF-16 text, postwrite verification failure, intervening main changes, mismatched or failed backup readback, and full-slot refusal or safe reuse.

The JSON report distinguishes completed checks from qualification. Any failed acceptance condition or incomplete run exits nonzero. Test storage hooks retain native methods for independent observations; they do not edit application source. Inspect the actual desktop and narrow screenshots, then exercise the existing platform receiver against the rebuilt archive. The source packager automatically includes this maintained review and documentation through its existing verification-file allowlist.

The authored-world import follow-on in issue #1 remains separate from this recovery contribution.
