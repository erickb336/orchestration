# Product

<!-- impeccable:product-schema 1 -->

<!-- Written 2026-10-01 from README.md, docs/PROJECT_SPEC.md, AGENTS.md and the owner's requests in this project's history, without a separate interview. Lines marked (inferred) are the lead's reading and await the owner's correction. -->

## Platform

web

## Users

- **Primary user.** A solo developer who builds several small apps and wants several AI coding agents to work on them at once. For example, the owner manages SimpleApps with it.
- **Where they use it.** On their own Mac, through a local web page at `127.0.0.1`.
- **What they need from it.** They check in between other work: to see progress, steer priorities, answer the few decisions that need them, and review what landed.
- **What they do not want.** They do not want to read code or approve every step. Autopilot is the default, and human review is optional.
- **Phone use** (to see progress or talk to the lead) is wanted later and not built yet.
- **Second audience (inferred):** developers who find the public repository and decide from the README and the demo whether to try it.

## Product Purpose

- **What it is.** Orchestrator is a local tool in which the user talks to one lead.
- **How it works.**
  - The lead plans tasks within a recorded vision, publishes a versioned spec for each, and runs it through a pipeline of steps.
  - The steps are design, implementation, service-run checks, independent review, repair and verification.
  - Each step runs on Claude or Codex, with the provider and model chosen per step.
  - Work lands as local branches or GitHub pull requests, held for the user or merged after an independent review and passing checks.
- **What success means.**
  - Several tracks of work move in parallel.
  - The user can see at a glance how far each part of the product is and what needs them.
  - Pause, edit and resume are truthful.

## Positioning

- **The difference from a single chat with one agent:**
  - parallel tracks, each with its own progress;
  - the work's state and history are durable;
  - independent review by a different agent;
  - checks run by the service, not merely claimed by the agent;
  - truthful controls: "Paused" appears only after the runtime acknowledges the stop.
- **Claude and Codex are equal citizens** under one scheduler. Neither is an add-on to the other.

## Operating Context

- It runs locally against the user's git repositories, using git worktrees for isolation.
- It is optionally connected to GitHub through `gh`.
- **The demo mode** runs a fake runtime with a sample project. Every simulated run is labelled as simulated.
- **Pipelines** come from JSON pattern files edited in code. They are never edited in the UI.

## Capabilities and Constraints

- **Shipped:**
  - shaping the vision with the lead;
  - vision documents;
  - steering by conversation, with Undo;
  - pull-request delivery, with a review-later queue;
  - quality gates (sandboxed checks, triaged findings, review coverage);
  - pipeline patterns, with provenance and outcome records.
- **Not yet verified in this environment:** real Claude and Codex model runs. The README must say so until evidence exists.
- **Constraints:**
  - nothing claims a capability without evidence;
  - simulated execution is always labelled;
  - the app never stores credentials;
  - SimpleApps code is never modified as a side effect.

## Brand Commitments

- **Name:** Orchestrator.
- **Look:** a black-and-white, ink-on-paper look, with black primary actions and the platform's sans-serif font (incumbent in code). Colour is used only to mean something.
- **Voice:** plain and literal. Short sentences; no hype; it says what is and is not done.

## Evidence on Hand

- **Real evidence:**
  - the test suite (878 tests at ORC-016);
  - a 25-of-25 pull-request sandbox run against a real GitHub repository, with scripted agents;
  - a real probe of the Codex sandbox on macOS;
  - screenshots in `docs/screenshots/`.
- **What does not exist and must not be invented:**
  - users, testimonials or adoption numbers;
  - benchmarks of real agent quality;
  - results of real Claude or Codex runs;
  - pricing.

## Product Principles

1. **Truthful state over optimistic state.** Desired state is shown apart from observed state.
2. **The user steers; the lead executes.** Specs are published, never forced as approval gates.
3. **One implementation, then independent review,** by default. Comparisons are opt-in experiments.
4. **Local-first and private by default.**
5. **Prefer mature open-source tools** to hand-built infrastructure.

## Accessibility & Inclusion

- **Inferred, from existing code:** keyboard-operable controls, visible focus, and `prefers-reduced-motion` respected.
- State is never conveyed by colour alone.
- **Light and dark themes** follow the system setting.
