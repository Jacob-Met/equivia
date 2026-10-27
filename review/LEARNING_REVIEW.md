# EQUIVIA independent learning and probability review

Status: independent oracles and review plan prepared; no local execution. This is a new causal experiment game, separate from prior product work.

## First playable proof

Show two lamps that agree under observation. In one world, fair root A determines B. In the other, fair root B determines A. Both assign probability one half to 00 and one half to 11. Repeating passive observation cannot distinguish these stipulated worlds.

Ask the learner to predict the next outcome before spending an experiment token. Clamping A to 1 changes the first world to always produce 11. The reverse world produces 10 or 11 with equal probability. Under equal prior weights, the predictive probabilities are therefore 25% for 10 and 75% for 11.

A single 11 outcome changes the two hypothesis weights to two thirds and one third. It does not establish a direction. A 10 outcome excludes the first hypothesis only within the displayed noiseless model set. After n repeated 11 outcomes under the same clamp, the forward hypothesis has weight 2^n/(2^n+1); finite evidence has not made the alternative impossible.

The learner should be able to spend a token on a useless experiment: clamping both lamps fixes both outcomes in every world and gains no information. Revealing why that experiment failed to distinguish hypotheses is part of the game. A suitable finite budget for the introductory challenge is four to six experiments, with the option to conclude that uncertainty remains.

State the trial-reset rule: the hidden structural world stays fixed, while fresh random inputs are drawn for each trial. The sequential likelihood calculations assume that conditional independence. A persistent hidden value reused across trials would be a different model and must not be explained with these updates.

## Conditioning and intervention must feel different

Selecting observed A=1 leaves only 11 in both worlds. Clamping A=1 replaces A's generating equation. These actions should have different labels, visual changes and probability calculations. The interface must not present filtering the observed rows as if it physically changed the mechanism.

Prediction should concern a visible outcome or its probability, not require the learner to guess the hidden world after every trial. Show the likelihood of the actual outcome under each candidate and how that changes its weight. A confident wrong prediction followed by an explanation grounded in those likelihoods is useful feedback; a generic model-authored explanation is insufficient.

## Hidden common cause counterexample

Add a third world in which hidden fair U determines both A and B. Its observational distribution is identical to the two directional worlds. Clamping A behaves like the B→A world; clamping B behaves like the A→B world. Therefore success on one direction-separating experiment does not eliminate the common-cause explanation.

With three equal priors, observing 10 after clamp A=1 gives weights (0, 1/2, 1/2). Observing 01 after a subsequent clamp B=1 gives (0, 0, 1). This conclusion is exact within the stipulated three-world deterministic model. It does not show that any real-world correlated pair has that causal structure.

## Failure states and limits

- **Impossible evidence** is separate from uncertainty. Observing A=0 while A is clamped to 1 has zero likelihood in every candidate. Preserve the previous state and explain the contradiction; do not return a uniform posterior, NaN values or invented certainty.
- **Prior support matters.** If all candidates that could explain evidence have prior weight zero, normalization fails under the chosen prior. That is a model/prior conflict, not ordinary ambiguity.
- **One eliminated hypothesis is not universal causality.** Posterior weights are conditional on the finite candidate set, structural equations, noiseless observations, independent trials and chosen prior.
- **Acyclic finite worlds only.** Reject structural cycles, missing parents, unknown variables, malformed binary values and truth tables, excessive nodes, excessive enumeration states, and oversized trial histories before costly work or partial mutation.
- **A model suggestion is a proposal.** Independently validate world structures and every experiment. Invalid suggestions must leave the game, experiment budget and replay history unchanged.
- **Replay is evidence.** Saving and reopening should preserve world definitions, prior, ordered interventions, observed outcomes, predictions, remaining budget and the resulting posterior. Recomputing the posterior from that transcript must match the saved state.

## Independent mathematical acceptance

The hand-written tables in `oracle.mjs` do not import the product engine. They cover all nine visible interventions (none, four single clamps, and four double clamps) in each of the three worlds. Required engine checks are exact observational equality, conditioning versus intervention, posterior predictive probabilities, one-outcome ambiguity, separating outcomes, impossible evidence, the two-step common-cause counterexample, sequential versus batch update equivalence, order-invariant posterior under independent fixed-world trials, and resource-limit rejection.

Expected information gain for one single-lamp clamp with two equal priors is about 0.311278124459 bits. Passive observation and double clamping have zero expected information gain for this candidate pair. This optional check prevents an experiment recommender from treating any action or any surprising outcome as useful causal evidence.

The eventual browser course should test prediction-before-experiment, one token per committed experiment, no token charged for invalid input or an uncommitted suggestion, zero-budget behavior, persistent replay, and explicit uncertainty after inconclusive outcomes. No browser or provider-runtime evidence is claimed by this document.

## Reviewed precision boundary

Exact arithmetic still needs explicit resource bounds. In the initial engine source, external prior terms are limited to 256 decimal digits. Three prior weights with denominators 10^150+1, 10^150+3 and 10^150+7 are individually within that bound, but normalizing them produces roughly 301-digit probabilities. Those returned probabilities exceed the same input limit if reused as a new prior. This is a source-derived boundary counterexample, not an executed failure report. The ordinary uniform-prior game does not approach it. Preserve the original prior and ordered history for replay, distinguish any precision-limit refusal from impossible evidence, and do not claim arbitrary sequential closure beyond the documented resource budget.
