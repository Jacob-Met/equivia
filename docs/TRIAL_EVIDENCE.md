# Read an experiment's effect on the evidence

Each experiment entry has a **How trial … changed the weights** disclosure. Open it with a pointer or with the keyboard (focus its summary and press Enter or Space).

For each declared candidate, the explanation shows:

- **Before this trial:** the candidate's conditional weight from all earlier recorded observations and experiments.
- **Chance of this result:** the exact probability that this candidate assigns to the selected recorded outcome under that trial's clamp. This is a model calculation, not the frequency in the sample.
- **After this trial:** the conditional weight after including that one result.

The before-weight is multiplied by the result's likelihood. The two amounts are then normalized to sum to one. Percentages are approximate displays; fractions use the existing exact engine.

For the matching-lamps example, the candidates begin at one half each. If you hold A on and record both lamps on, A drives B assigns probability one and B drives A assigns probability one half to that result. The resulting weights are two thirds and one third. A second identical result changes those weights to four fifths and one fifth. Both remain possible.

A zero likelihood can exclude a candidate within these declared rules. A candidate already excluded by earlier evidence stays excluded. A missing normalization is shown as undefined, which is different from a valid zero weight.

## Original trial boundaries

The explanation uses the original recorded intervention and outcome. It includes passive observations earlier in the notebook and excludes every later trial. A batch of three has three individual entries; the second and third explanations use the evidence preceding each individual trial. Reopening a notebook recomputes these explanations from its validated record; no new derived fields are saved.

You can continue inspecting the trial explanations after finishing the investigation. Starting or opening a different notebook discards the old disclosure state. Inspection does not spend experiment tokens, update the learner's estimate, modify the saved notebook, request a model response, or reveal which candidate was used.

## What the weights establish

Weights measure support within the supplied finite candidate set and its equal starting weights. They assume a fixed mechanism and fresh independent random inputs for each trial. They do not establish that all possible mechanisms have been considered, or that the learner has discovered a real-world causal law.

The whole-run forecast panel remains a separate view of a run's predicted results and the next hypothetical trial. This journal explanation concerns one original recorded result.

## Receiving

`test/trial-evidence.test.mjs` checks independently specified exact cases, historical boundaries, undefined evidence, and nonmutation. The browser receiver exercises the real entry point, keyboard disclosure, later evidence, save/reopen, narrow layout and an extracted maintained package. Receipt files identify the source and paths actually executed; a source-only test does not establish packaged delivery.
