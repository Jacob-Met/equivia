# Share EQUIVIA's recorded evidence

Use **Save evidence report** in the experiment notebook to download equivia-evidence-report.html. The file is self-contained: open it in a browser without a network connection, or use the browser's print command.

The report preserves the full ordered history of individual watches and intervention trials. An intervention's recorded prediction is the learner's estimated probability that the **other, unclamped lamp** would be on. A batch of three retains three individual records; the report does not reconstruct button-click groups.

Candidate weights are computed from the listed public mechanisms and complete recorded history, with equal starting weights. Exact fractions accompany approximate displayed percentages. Predictions and the explanation do not enter this probability calculation. An incompatible record has undefined posterior weights; it does not become a uniform fallback or a winning candidate.

The explanation is the current text at export, not a record of earlier beliefs. A notebook opened from a file remains the notebook being reported: the report does not assert that its trials were collected locally or establish physical-world measurements. No completion state is inferred.

## What is omitted

The stored hidden candidate selection, initial/current random seeds, per-trial replay seeds, and unrelated metadata are not copied. Candidate IDs and mechanisms are public evidence and remain in the report. Observations or your own text may identify or suggest a candidate; this is not an anonymity or secrecy guarantee.

The report is not accepted by **Open notebook** and cannot resume a session. Keep a separate **Save notebook** file for a replayable investigation; that file includes the hidden selection and replay state.

## Models and limits

Each public rule table retains its original index order. To form an index, read parent bits in their listed order, then append the variable's local noise bits. Local noise bits are independent and uniformly distributed. A clamp replaces that variable's rule.

These are bounded, authored binary models. High relative support does not prove a candidate true or rule out mechanisms outside the supplied set. An empty record shows starting weights and explicitly reports that no trials have been recorded.
