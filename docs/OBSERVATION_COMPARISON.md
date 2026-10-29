# Watching and holding

This comparison lets a learner inspect two different questions about each supplied candidate mechanism. Choose one lamp and an on/off value, then compare the distribution of the other lamp.

- **Watching** selects naturally occurring model runs in which the chosen lamp already has that value. All generating equations stay intact. The exact support fraction reports how much of the natural population matches the selection.
- **Holding** replaces the chosen lamp's generating equation with that fixed value and lets the remaining equations respond. No natural runs are selected away.

These are exact calculations under the supplied finite binary model and its independent uniform noise bits. Fair noise bits do not require a lamp to be on half the time: a truth table can produce a biased lamp. Holding a lamp fixes its value regardless of its natural frequency.

## Matching-lamps example

In the introductory pair, A drives B in one mechanism and B drives A in the other. The root lamp is fair and the second lamp copies it. In either mechanism, natural observations are 00 with probability 1/2 and 11 with probability 1/2.

Selecting natural runs where A is on retains half the population. Every retained run has B on, in both mechanisms. Holding A on has a different implication: B is on with probability 1 in the A-drives-B mechanism and with probability 1/2 in the B-drives-A mechanism. The latter operation changes A's equation; B remains a fair root.

The same distinction works in either direction and for either selected value. For example, watching B off implies A off in both introductory mechanisms, whereas holding B off leaves A fair when A drives B.

## Impossible natural selections

If a selected value never occurs naturally, its support is zero. The conditional distribution is undefined: there are no matching runs to compare. The interface must show this explicitly, rather than displaying a zero-percent chance for the other lamp. Holding that value can still have a valid result. For example, if A is naturally always off and B copies A, watching A on is impossible, while holding A on makes B on.

## Scope and implementation

`compareObservation(world, clamp)` in `src/observation-comparison.js` computes a separate result for each candidate world using the maintained engine. `watched` uses `distribution` with a condition; `held` uses it with an intervention. Both report the other observed lamp's exact distribution. The returned `watched.evidence` is the natural selection's support; `zero_evidence` and its empty outcome list remain explicit.

The comparison does not select the session's hidden world, average across posterior weights, filter the recorded notebook, or generate a new trial. It does not consume experiment tokens, advance a random seed, change hypothesis weights, or alter the explanation. It is read-only and remains useful after an investigation is complete. Changing its selection changes only the comparison being inspected. The comparison keeps that selection when trial controls change or its panel is closed and reopened. Opening a different investigation initializes a new comparison choice.

This feature supports examining the mathematical distinction in the supplied models. It does not establish that learners understand the distinction better; educational efficacy requires learner evaluation. The examples above are mathematical expectations, not a report that implementation, browser, or package checks have passed.

Executed source and browser evidence is recorded in [the receiving report](OBSERVATION_COMPARISON_RECEIVING.md).
