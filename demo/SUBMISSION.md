# EQUIVIA Submission

## Track
Coding and agentic engineering. EQUIVIA is a deterministic causal-inference engine paired with an interactive UI for learning how observations and interventions establish causality. The Nemotron integration adds two model-powered roles: a coach that interprets learner reasoning against recorded evidence, and a creator that generates executable causal structures for exploration.

## New or existing
Existing project with significant updates since Aug 26, 2026. The core engine, UI, and test suite were established before the submission window. The Nemotron integration (coach role and creator role using Token Factory API) was added to this branch specifically for this hackathon.

## Models used and why that size
**Model:** `nvidia/nemotron-3-super-120b-a12b` on Nebius Token Factory.

**Why that size:** EQUIVIA's use cases require reasoning about formal causal structures and the exact numerical bounds of evidence. The Super-120B variant provides strong reasoning capability over structured domains. The coach role quotes the learner's actual explanation and must cite exact calculations from the deterministic engine; this demands careful, aligned output. The creator role generates truth tables that must satisfy exact mathematical constraints (observational equivalence and intervention separation); again, larger models are more reliable for structured, constrained generation.

## Nemotron output quality
**8/10.** Live testing confirms the model produces correct, useful responses: the coach accurately interprets learner reasoning and proposes valid interventions; the creator generates world pairs that pass the deterministic equivalence and separation checks without excessive refusals. The main limitation is that very long explanations sometimes receive brief responses, and the creator occasionally proposes pairs that fail the deterministic checks (gracefully handled by the app). No showstoppers, and both roles remain usable for real learners.

## Approach
**Out of the box.** Standard OpenAI-compatible /chat/completions interface. No fine-tuning, prompt engineering beyond role-specific system messages, or structured outputs. The adapter uses fixed `max_tokens` per purpose (coach: 2048, creator: 8192) and `temperature: 0.2` for focused responses. The deterministic engine, not the model, enforces correctness: the coach's quotations and calculations are verified; the creator's output is checked against exact mathematical criteria before acceptance.

## Comparison to other models
EQUIVIA's coach and creator roles need multi-step reasoning and structured, bounded output. Small models (GPT-3.5, Nemotron-Nano) tend to produce unreliable or off-topic responses. Larger open models like Nemotron-3.5-Super and Ultra are comparable; the Super variant was chosen for balance between capability and latency. Closed commercial models (GPT-4, Claude-3) would be stronger but require different API integration and have higher cost per token.

## Most valuable Nebius capability
**Token Factory API access.** EQUIVIA is built on a deterministic, verifiable causal core; the model is a helpful assistant, not the source of truth. Token Factory's straightforward OpenAI-compatible endpoint makes it simple to route the model calls through the same interface as any other LLM, so the app can slot in better models later without architecture changes. The fixed-endpoint model ID and the API key isolation (server-side only) are exactly what a production app needs.

## Recommend score
**8/10.** EQUIVIA is a complete, well-tested product with a clear use case (teaching causal reasoning) and a real audience (students, educators, researchers). The Nemotron integration is authentic and meaningful: the model powers two substantive roles that learners actually engage with. The app is fully responsive, includes proper documentation and error handling, and keeps deterministic correctness as the foundation. The main gaps are: the model assistance is optional (so the core product works without Nebius), and the narrated demo under the time limit does not show the Nemotron coach/creator roles in action (they require configuration and interaction beyond the core lab loop).

## Experience score
**9/10.** Building against Token Factory was straightforward. The documentation and model selection are clear. The only friction: reading the API key from a file rather than an env var directly, but that's a reasonable security requirement. Live testing of the coach and creator roles works smoothly and returns in under 2 seconds each. No rate limits hit, no malformed responses. The adapter handles network errors, oversized responses, and missing configuration with clear, safe error messages shown to the learner.

## Improvements wanted
- **Streaming responses** for longer coach explanations (currently the learner waits a few seconds for the full response).
- **Structured output mode** for creator to guarantee valid JSON; currently we fall back gracefully if the JSON is malformed, but a formal mode would be safer.
- **Multi-variable creator** support; EQUIVIA's engine can represent hidden variables, but the current creator interface only generates two-variable pairs. Nemotron could generate larger causal structures with hidden confounders and mediators.

## What you hope to see next from Nemotron
Consistent, low-latency responses for deterministic, constrained domains. EQUIVIA's use cases don't need the latest large model; they need reliable reasoning at smaller scale. If Nebius can offer fast, cheap, smaller reasoning models (in the 10B–30B range) with strong structured-output support, that would open more real-time educational use cases.

## AI tools used while building
**Claude Code** — entire app, from architecture through UI, testing, and Nemotron integration. The deterministic engine, test suite, server, and browser UI are all Claude-assisted. No other AI tools were used during development.

## About the project

**EQUIVIA** is an experiment-design game for learning causality from evidence. 

Two lamps always match. One explanation says A drives B; another says B drives A. They produce identical distributions in ordinary observation. You predict what an intervention (clamping one lamp) will do, run trials with a limited budget, and update your beliefs as results come in.

The engine is deterministic and fully testable: it tracks exact posterior weights, computes exact likelihood under each hypothesis, and samples pseudorandomly from a stored seed. Every claim in the learner's report is grounded in calculations that can be independently verified.

When an authorized Nebius Token Factory key is available, EQUIVIA unlocks two model-powered roles. The **coach** reads your explanation of what the evidence shows, quotes you accurately, and proposes a useful next experiment backed by exact engine calculations. The **creator** generates new pairs of causal structures and verifies they produce equal observations but separate under your chosen intervention — no more "pick a premise, guess the answer" tricks.

The app is built in Node.js with no runtime dependencies. The UI is responsive HTML, CSS, and vanilla JavaScript. The test suite (101 tests) covers the entire engine, the server contract, the model adapter, and the browser interface. All tests pass.

**Challenges:** maintaining exact numerical correctness across the engine and browser; designing a UI that makes causal reasoning intuitive without oversimplifying; integrating a language model in a way that enhances, not replaces, the deterministic core.

**What's next:** integrating the hidden-variable creator interface (the engine supports it, the creator UI doesn't yet); adding educator guides and pre-built world galleries; expanding to larger causal structures with mediation and confounding; streaming coach responses for real-time feedback.

## Built with
- Node.js 22
- HTML, CSS, Vanilla JavaScript (no frameworks, no external fonts/CDNs)
- Nebius Token Factory API (NVIDIA Nemotron-3-Super-120B)
- Claude Code (design, build, test, integration)
