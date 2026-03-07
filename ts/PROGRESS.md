# Symphony TypeScript Implementation Progress

## Phase 1: Core Infrastructure (Complete)
- [x] Project scaffolding with Bun runtime
- [x] Domain types (`src/types.ts`) - Issue, WorkflowDefinition, OrchestratorState, AgentEvent, Provider interfaces
- [x] Structured logging (`src/logger.ts`) - key=value format with level control
- [x] Workflow loader (`src/workflow.ts`) - YAML front matter + prompt body parsing
- [x] Config layer (`src/config.ts`) - typed getters, defaults, $VAR resolution, ~ expansion, validation
- [x] Prompt builder (`src/prompt.ts`) - LiquidJS strict rendering with issue/attempt/language/default_branch

## Phase 2: Execution Layer (Complete)
- [x] Workspace manager (`src/workspace/manager.ts`) - create/reuse, hooks, safety invariants, path sanitization
- [x] Codex app-server provider (`src/providers/codex.ts`) - JSON-RPC stdio, handshake, turn streaming, approval auto-approve, linear_graphql tool
- [x] Claude Code provider (`src/providers/claude.ts`) - Agent SDK integration, event normalization
- [x] Provider registry (`src/providers/registry.ts`) - label-based routing, first-match-wins

## Phase 3: Orchestration (Complete)
- [x] Orchestrator (`src/orchestrator.ts`) - poll loop, dispatch, reconciliation, retry queue, stall detection, token accounting
- [x] Workflow watcher (`src/watcher.ts`) - chokidar file watching for dynamic reload
- [x] HTTP server (`src/server.ts`) - dashboard, JSON API (/api/v1/state, /api/v1/refresh, /api/v1/<id>)
- [x] CLI entry point (`src/main.ts`) - arg parsing, startup, graceful shutdown

## Phase 4: Testing (Complete)
- [x] Workflow loader tests (7 tests)
- [x] Config layer tests (13 tests)
- [x] Prompt builder tests (7 tests)
- [x] Workspace manager tests (9 tests)
- [x] Orchestrator dispatch/sort/blocker/label/retry tests (12 tests)
- [x] Provider registry/routing tests (5 tests)
- Total: 54 tests, all passing

## Spec Coverage
- Section 4: Core Domain Model - fully typed
- Section 5: Workflow Specification - loader, config schema, prompt template
- Section 6: Configuration - defaults, $VAR, dynamic reload, dispatch validation
- Section 7: Orchestration State Machine - all states, transitions
- Section 8: Polling, Scheduling, Reconciliation - poll loop, candidate selection, concurrency, retry backoff, stall detection, startup cleanup
- Section 9: Workspace Management - creation, reuse, hooks, safety invariants, hook env vars
- Section 10: Agent Runner Protocol - Codex (10.1-10.7), Claude (10.8)
- Section 11: Linear integration - GraphQL client, normalization, pagination, blocker resolution
- Section 12: Prompt Construction - strict rendering, retry semantics
- Section 13: Observability - structured logs, HTTP server, JSON API, dashboard
- Section 14: Failure Model - all error classes handled with retry/recovery
- Section 15: Security - workspace path validation, secret handling
- Section 17: Test matrix - core conformance covered
