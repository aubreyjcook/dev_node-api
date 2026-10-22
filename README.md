# dev_node-api

A minimal RESTful API written in Node.js and TypeScript, built **without frameworks or runtime dependencies** for the purpose of learning how a REST API works from the socket up.

This repository is in **alpha** and is versioned as a sequence of self-contained snapshots. Each version lives in its own directory and is a complete copy of the project at that point in its evolution — so you can open any two versions side by side and see exactly what changed, why, and what came next.

> New here? Start with the **latest version** below, and read that version's `README.md` first.

## Versions

| Version | Directory | Status | What it is |
|---|---|---|---|
| **v0.01** | [`v0_01/`](v0_01/) | alpha | The initial version: the full CRUD task API, the router and middleware pipeline, and the complete learning documentation |
| v0.02 | *(not created yet)* | planned | See [`v0_01/ROADMAP.md`](v0_01/ROADMAP.md) |

## How the versions are organised

Each `v0_0x/` directory is **self-contained**: it holds that version's source code, tests, documentation, and its own `package.json`/`tsconfig.json`, so it builds and runs on its own with no reference to any other version.

Every version also ships two documents that record its place in the timeline:

- **`CHANGELOG.md`** — what changed in *this* version relative to the previous one (for a learner: *why* the change was made and how it works).
- **`ROADMAP.md`** — the plan for the *next* version.

## Requirements

- **Node.js 24 or newer.** Node 24 executes TypeScript natively, which is what makes this project dependency-free. `.nvmrc` pins the version; with nvm, run `nvm use`.
- No runtime dependencies are required — only `typescript` and `@types/node` as development tools.

## Project governance

The master working instructions for this repository live in [`agent-instructions.md`](agent-instructions.md). Individual version directories may contain further instructions that apply only to that version.
