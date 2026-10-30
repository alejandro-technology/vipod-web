# Project Instructions

## Scope

This directory is the independent `vipod-web` sibling project. The existing `vipod` mobile project is read-only and out of scope. Keep source code, UI labels, and documentation in English.

## Ownership

- Backend worker: `src/app/api/`, `src/lib/server/`, and `tests/`.
- Frontend worker: `src/app/page.tsx`, `src/app/globals.css`, and `src/components/`.
- Parent integrator: shared contracts, configuration, and cross-worker integration.
- `src/lib/contracts.ts` is the shared type contract; coordinate contract changes with the parent integrator.

## Workflow

- Do not initialize git, create branches, or commit unless explicitly requested.
- Keep local media and job data under the ignored `.vipod-data/` directory unless configured otherwise.
- Use the project scripts for linting, type checking, building, and tests.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
