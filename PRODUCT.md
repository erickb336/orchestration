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
- **Audience for the README and the demo** (confirmed by the owner, 2026-10-01): future employers and developers who find the public repository.
  - Employers judge the engineering and the craft.
  - Developers decide in seconds whether to try it.
  - The sample project in the demo is only a backdrop; what is shown is Orchestrator itself.

## The core problem

In the owner's words (2026-10-02):

> "The core problem I want this project to solve is how data/artifacts/etc convey things to the human. I want to get as far away from the code as possible and remove human from the loop of development. Human is still looking at code because there is a mismatch between what is in human head vs and what the chat session believes or assumes. This project should be about coming up with the best way to represent each part of the design processes for the human to understand and be able to get information that is needed from the human to reach alignment."

And, refining it the same day: it is "like an information and data representation problem". The owner does not want to look at code at all: "the point is too create the principles and loops so the good code patterns structure etc are a by product that I don't need to worry about. But I believe the way to get there is to help the human get develop the vision and design of the change/product/etc fully before implementation happens", "before the factory starts".

**What this means for every feature:**

- **Before the factory starts, the human's part is made complete.**
  - In Vision (ORC-029), each part of the design is shown in the form that makes a mismatch with the owner's intent obvious, and the owner's input is asked for in the cheapest form to answer:
    - the experience as prototypes;
    - the data as the product's things and how they relate, with worked examples;
    - the flows, with every rule and edge case decided (for example, as a table of cases and outcomes).
  - Messy special-casing in code usually comes from a case the design never decided, so deciding cases up front is how good code becomes a by-product.
  - The pre-flight shows how complete the design is before the owner starts the factory.
- **Changes after the start are designed the same way.** A new feature or change goes back through the studio, and only its approved design reaches the factory, as a change order.
- **During building, nobody reviews code.** What the owner used to check in code becomes rules the factory enforces on itself, through its own loops:
  - structure, data shapes, patterns, nested ternaries and special cases (the owner's list, 2026-10-02);
  - enforced by principles given to agents, automated checks, and code and PE review that repair what they find.
  - The owner sees only the decisions that genuinely need them.

## Product Purpose

In the owner's words (2026-10-01): "a starting playground for me to develop and test different patterns for and ways of using multiple agents in my workflows. My goal is to remove myself from the loop as much as possible and review only artifacts and working prototypes rather than spending too much time on details and instead focus on building working solutions that are testable end-to-end."

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
- **Pipelines** come from six flows (Change, Bug fix, Feature, Design, Investigation, Goal), each a JSON file edited in code. They are never edited in the UI.

## Capabilities and Constraints

- **Shipped:**
  - shaping the vision with the lead;
  - vision documents;
  - steering by conversation, with Undo;
  - pull-request delivery, with a review-later queue;
  - quality gates (sandboxed checks, triaged findings, review coverage);
  - six flows, with a code review and a security review beside it wherever code changes (ORC-021);
  - one component kit for every screen, shown at `#/kit`, so the UI stays consistent (ORC-025).
- **Verified with real models (four runs on 2026-10-01):** Claude and Codex agents running at once, truthful pause and resume per task and per project, notes acknowledged by both runtimes, review findings repaired before the lead's spec, and both tasks completing (`npm run test:real`; records in `docs/real-runs/`).
- **Not yet verified with real models:** pull-request delivery, conversations with the lead, and the principles' effect. The README must say so until evidence exists.
- **Constraints:**
  - nothing claims a capability without evidence;
  - simulated execution is always labelled;
  - the app never stores credentials;
  - SimpleApps code is never modified as a side effect.

## How it is presented

- **For employers,** the README shows creativity: tools built to add value to the owner's own workflow, what is measured, and the care given to UX. Engineering rigour supports this; it is not the headline.
- **How it was built,** stated plainly: the owner steered, AI agents in Claude Code (a lead, plus designer, coder and reviewer agents) wrote the specs and the code, and every step had an independent review.
- **No author line or byline.**

## Brand Commitments

- **Name:** Orchestrator.
- **Look:** dark only (the owner, 2026-10-01): near-black surfaces with a cool cast, light text, light primary actions, and the platform's sans-serif font. Colour is used only to mean something: blue for running, amber for "needs you", green for done, red for failed.
- **Voice:** plain and literal. Short sentences; no hype; it says what is and is not done.

## Evidence on Hand

- **Real evidence:**
  - the test suite (`npm test` prints the current count);
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
3. **One implementation, then independent review.** No competing implementations.
4. **Local-first and private by default.**
5. **Prefer mature open-source tools** to hand-built infrastructure.

## Accessibility & Inclusion

- **Inferred, from existing code:** keyboard-operable controls, visible focus, and `prefers-reduced-motion` respected.
- State is never conveyed by colour alone.
- **One dark theme,** whatever the system setting.
