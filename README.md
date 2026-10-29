# EQUIVIA

**A laboratory for better questions.** EQUIVIA is an experiment-design game for learning what observations and interventions can establish. It is selected concept 3 in the HAMON product portfolio, not a renamed substitute project.

Two lamps always match. One candidate says A drives B; the other says B drives A. Watching gives exactly the same distribution in both worlds. You predict what a clamp will do, spend a limited experiment budget, and update the evidence without automatically revealing the answer.

The first lesson is deliberately small enough to check completely. Under `do(A=1)`, A→B predicts `11` with probability 1, while B→A predicts `10` and `11` with probability 1/2 each. A single `11` changes equal starting weights to 2/3 and 1/3. It does not prove the first world. An observed `10` excludes the first candidate **within this specified noiseless model set**.

## Run the laboratory

Requires Node.js 22 or newer. The application has no runtime npm dependencies and uses no external fonts, assets, or client scripts.

```sh
npm start
```

Open the printed loopback address, normally `http://127.0.0.1:4192`. Set `PORT=0` for an available ephemeral port. The server is deliberately local; no deployment or public exposure is configured.

1. Watch the initial observations. The exact shared distribution is shown separately from the finite sample counts.
2. Choose A or B and whether to hold it on or off.
3. Enter any probability estimate from 0 through 100 percent for the other lamp being on.
4. Run one trial or a batch of three. Every individual trial spends one of the six tokens.
5. Compare the remaining candidates and exact conditional weights. The structural world stays fixed; trials draw fresh pseudorandom inputs.
6. Finish when ready to reveal the authored mechanism. The debrief distinguishes the hidden answer from what the recorded evidence establishes.

The notebook is saved in this browser's local storage. **Save notebook** exports the candidate worlds, predictions, ordered observations, and replay state. **Open notebook** validates the complete executable replay before replacing the current investigation. Invalid or altered outcomes leave the current work intact. The hidden identity and seed are present in the local notebook; this is a teaching tool, not a protected examination or secret storage system.

## Recover a saved notebook

Valid saved notebooks reopen normally. If a saved notebook cannot be reopened, EQUIVIA protects the text it first read and lets you continue with a temporary investigation. Automatic saving stays paused; use **Save notebook** to keep your current investigation as a portable file.

**Back up and replace saved notebook** first creates a separate browser recovery copy and reads it back to verify that it matches the original text. Only then can replacement proceed. EQUIVIA keeps up to eight browser recovery copies and does not evict an existing copy to make room.

You can download recovery copies as JSON files. These preserve the exact saved text captured by the recovery process, including the initial text when another tab has since changed the saved notebook. They are files for repair, not ordinary notebooks you can open with **Open notebook**. Browser recovery copies can disappear when browser storage is cleared; they are not backups on disk.

If the initial saved notebook cannot be read, saving remains paused until you reload. If a replacement cannot be verified, automatic saving and further replacement attempts remain paused. In either case, use **Save notebook** to keep your current investigation, then reload to inspect the saved notebook again.

## Optional NVIDIA model assistance

The laboratory works without a model connection. When an existing authorized Nebius route is configured, two substantive model roles are available:

- **Reasoning coach:** reads the learner's actual explanation and permitted evidence, quotes the learner accurately, proposes a reviewable interpretation and useful experiment, and cites exact calculations from the deterministic engine. The learner can reject the interpretation. The actual hidden-world identity and random seed are not sent.
- **Creator studio:** generates executable candidate mechanisms as truth tables. EQUIVIA enumerates them independently and accepts a pair only if the full observational distributions are equal and the proposed intervention separates them. This is generated causal structure, not a model choosing a decorative title for a fixed answer.

Configure `NEBIUS_API_KEY` and `NEBIUS_MODEL` in the server's process environment using an already authorized account. `.env.example` documents names; the application does not automatically read `.env` files. The verified [official Nebius cookbook](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/nemotron3-super-120B.md) identifies `nvidia/nemotron-3-super-120b-a12b` with the default endpoint `https://api.tokenfactory.us-central1.nebius.com/v1/`. An explicit model is required. The adapter has bounded requests, no automatic retries, and no simulated offline model answer.

The current lamp authoring interface requests exactly two observed variables, A and B. Hidden-variable generation is not currently supported by that interface, even though the exact engine can represent hidden variables. Generated labels and tentative interpretations are not scientific findings. See [the model contract](docs/MODEL_CONTRACT.md) for the precise boundary.

**Live model status:** no live Nebius response has yet been qualified in this source increment. Provider, guide, and authoring tests use clearly labeled synthetic transport fixtures. They establish application behavior, not successful NVIDIA execution, model quality, account availability, or contest eligibility.

## Portable Windows build

The [private Windows x64 build](docs/WINDOWS.md) includes its verified Node runtime and a local command launcher. It keeps the normal notebook address, runs without an installed Node, and leaves model assistance unconfigured.

## Portable Mac build

The [private Mac build](docs/MACOS.md) includes a verified Node runtime and a Terminal launcher for Apple silicon. Its normal address preserves browser notebook storage; temporary sessions are optional. The deterministic laboratory works locally, and this launcher leaves model assistance unconfigured.

## Portable Linux build

The [private Linux x64 build](docs/LINUX.md) includes a verified Node runtime and a terminal launcher. Open the printed local address in your browser; the normal address preserves notebook storage. See the artifact receiving report for the exact platform and browser checked.

## Verification and portable package

```sh
npm test
npm run verify
node review/engine-review.mjs receipts/independent
npm run package
```

The independent mathematical review uses separate reference arithmetic and explicit expected worlds. The package command constructs an explicit source allowlist, writes SHA-256 manifests, extracts into a separate directory, checks every file, runs the extracted unit tests, and starts the actual extracted CLI for HTTP smoke checks. It does not publish or deploy anything.

Actual browser review uses a separately installed Playwright and a Chrome executable:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_EXECUTABLE=/absolute/path/to/google-chrome \
node review/browser-review.mjs receipts/browser
```

Chrome runs with its sandbox enabled. The review serves the real application on ephemeral loopback ports and exercises downloads, reloads, budget use, exact posterior changes, malformed notebook preservation, explicit authored-case adoption, stale guide responses, and mobile geometry. Its separate guide/author server injects `TEST_STUB` responses; no cloud model is called. Screenshots require human visual review in addition to passing interaction assertions.

The executed source and current evidence are recorded in [the work record](docs/WORK.md). The engine contract is in [ENGINE.md](docs/ENGINE.md); independent learning limitations are in [LEARNING_REVIEW.md](review/LEARNING_REVIEW.md).

## Mathematical and product limits

All equations are finite binary structural causal models with independent uniform local noise bits. The engine uses exact rational arithmetic for enumeration and Bayesian candidate weights; approximate percentages are only displays. Conditioning filters naturally occurring worlds. Intervention replaces an equation. These are different operations.

Worlds have bounded size: at most 12 variables and 12 total noise bits, at most 4096 enumerated assignments, and at most 64 history entries. The game currently presents two candidates and two observed lamps. Equal initial candidate weights are a declared convention. A high posterior weight is not a proof; an omitted mechanism may fit the same evidence. The seeded replay generator supports reproducibility, not cryptographic randomness or unrestricted real-world causal discovery.

The closest prior art reviewed for this increment is [WhyNot](https://github.com/socialfoundations/whynot), a causal-inference and sequential-decision simulation framework with research and teaching use. EQUIVIA's product hypothesis is a compact playable studio centered on observational equivalence, prediction, intervention budgets, and exact auditable generated puzzles. That is a proposed learning experience, not a claim to have invented causal inference or demonstrated educational efficacy.

## Private development

The repository and source remain private. No public release, competition submission, new spending, account creation, or deployment is implied. See [LICENSE](LICENSE).
