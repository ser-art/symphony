# Symphony TypeScript

Agent orchestration service that polls a Linear project for issues and dispatches AI coding agents (Codex or Claude) to work on them autonomously.

## Prerequisites

- [Bun](https://bun.sh/) v1.0+
- A [Linear](https://linear.app/) account with an API key
- One or both agent backends:
  - **Codex**: `codex` CLI installed and available on `$PATH`
  - **Claude**: `@anthropic-ai/claude-agent-sdk` (bundled as a dependency)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LINEAR_API_KEY` | Yes | Linear API key (used by default if `tracker.api_key` is `$LINEAR_API_KEY`) |

The `tracker.api_key` config value supports `$VAR` syntax to reference any environment variable.

## Installation

```bash
cd ts
bun install
```

## Running

```bash
# Default: reads ./WORKFLOW.md
bun run start

# Specify a different workflow file
bun run start path/to/WORKFLOW.md

# Enable HTTP dashboard on a port
bun run start --port 4000

# Enable debug logging
bun run start --debug

# Compile to a standalone binary
bun run build    # produces bin/symphony
```

### CLI Flags

| Flag | Description |
|---|---|
| `<path>` | Path to WORKFLOW.md (default: `./WORKFLOW.md`) |
| `--port <n>` | Start HTTP server on port `n` (overrides `server.port` in config) |
| `--logs-root <dir>` | Log output directory (reserved, not yet wired) |
| `--debug` | Set log level to `debug` |

## Configuration (WORKFLOW.md)

Symphony is configured through a single Markdown file with YAML front matter. The body after the front matter is the prompt template sent to agents.

```markdown
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  trigger_labels: []

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces
  default_branch: dev

hooks:
  after_create: "git clone git@github.com:org/repo.git ."
  before_run: "git checkout $SYMPHONY_DEFAULT_BRANCH && git pull"
  after_run: null
  before_remove: null
  timeout_ms: 60000

agent:
  max_concurrent_agents: 10
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    todo: 3
    in progress: 5
  language: ru
  default_provider: codex
  default_system: simple

codex:
  command: codex app-server
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

claude:
  model: claude-sonnet-4-6
  max_turns: 20
  permission_mode: dangerouslySkipPermissions
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000

routing:
  rules:
    - labels: [claude]
      provider: claude
    - labels: [codex]
      provider: codex

server:
  port: 4000
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}.

{{ issue.description }}

Target branch: {{ default_branch }}
Language: {{ language }}
```

### Config Reference

All keys are optional and have defaults.

#### `tracker`

| Key | Default | Description |
|---|---|---|
| `kind` | `""` | Tracker type. Only `linear` is supported. |
| `endpoint` | `https://api.linear.app/graphql` | Linear GraphQL endpoint |
| `api_key` | `$LINEAR_API_KEY` | API key (supports `$VAR` env resolution) |
| `project_slug` | `""` | Linear project slug ID |
| `active_states` | `["Todo", "In Progress"]` | Issue states that trigger agent dispatch |
| `terminal_states` | `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]` | States that stop agents and clean up workspaces |
| `trigger_labels` | `[]` | If non-empty, only issues with at least one matching label are dispatched |

#### `polling`

| Key | Default | Description |
|---|---|---|
| `interval_ms` | `30000` | Milliseconds between poll ticks |

#### `workspace`

| Key | Default | Description |
|---|---|---|
| `root` | `$TMPDIR/symphony_workspaces` | Root directory for per-issue workspaces |
| `default_branch` | `dev` | Git branch name passed to hooks and prompt templates |

Path values support `~` (home directory) expansion and `$VAR` env resolution.

#### `hooks`

| Key | Default | Description |
|---|---|---|
| `after_create` | `null` | Shell script run after a new workspace directory is created |
| `before_run` | `null` | Shell script run before each agent session starts |
| `after_run` | `null` | Shell script run after each agent session ends |
| `before_remove` | `null` | Shell script run before workspace cleanup |
| `timeout_ms` | `60000` | Maximum hook execution time in ms |

Hooks run via `bash -lc` with these environment variables:

| Variable | Value |
|---|---|
| `SYMPHONY_WORKSPACE_PATH` | Absolute path to the workspace directory |
| `SYMPHONY_ISSUE_IDENTIFIER` | Linear issue identifier (e.g. `PRJ-123`) |
| `SYMPHONY_DEFAULT_BRANCH` | The configured `workspace.default_branch` |
| `SYMPHONY_LANGUAGE` | The configured `agent.language` |

#### `agent`

| Key | Default | Description |
|---|---|---|
| `max_concurrent_agents` | `10` | Global max concurrent agent sessions |
| `max_turns` | `20` | Max turns per issue before stopping |
| `max_retry_backoff_ms` | `300000` | Max delay for exponential retry backoff |
| `max_concurrent_agents_by_state` | `{}` | Per-state concurrency limits (e.g. `{ "todo": 3 }`) |
| `language` | `ru` | Language code passed to prompts and hooks |
| `default_provider` | `codex` | Default agent provider (`codex` or `claude`) |
| `default_system` | `simple` | Default system prompt style |

#### `codex`

| Key | Default | Description |
|---|---|---|
| `command` | `codex app-server` | Shell command to start the Codex app server |
| `approval_policy` | `never` | Codex approval policy |
| `thread_sandbox` | `workspace-write` | Thread sandbox mode |
| `turn_sandbox_policy` | `{ type: "workspaceWrite" }` | Turn-level sandbox policy |
| `turn_timeout_ms` | `3600000` | Max time per turn (1 hour) |
| `read_timeout_ms` | `5000` | Timeout for JSON-RPC responses during handshake |
| `stall_timeout_ms` | `300000` | Time without events before a session is considered stalled |

#### `claude`

| Key | Default | Description |
|---|---|---|
| `model` | `claude-sonnet-4-6` | Claude model ID |
| `max_turns` | `20` | Max turns passed to the Claude Agent SDK |
| `permission_mode` | `dangerouslySkipPermissions` | Permission mode for Claude sessions |
| `turn_timeout_ms` | `3600000` | Max time per turn |
| `stall_timeout_ms` | `300000` | Stall detection timeout |

#### `routing`

Routes issues to specific providers based on Linear labels. Rules are evaluated in order; first match wins.

```yaml
routing:
  rules:
    - labels: [claude, needs-claude]
      provider: claude
    - labels: [codex]
      provider: codex
```

If no rule matches, `agent.default_provider` is used.

#### `server`

| Key | Default | Description |
|---|---|---|
| `port` | `null` | HTTP server port. If unset, no server starts. |

## Linear Integration

### Targeting Issues to Symphony

Symphony doesn't use @mentions. Instead, use **trigger labels** to control which issues Symphony picks up:

```yaml
tracker:
  trigger_labels:
    - symphony
```

With this config, only issues labeled `symphony` in Linear will be dispatched. Add the label in Linear to any issue you want an agent to work on. Without `trigger_labels` (the default), Symphony works on **all** issues in active states within the project.

### Setup

1. Create a Linear project and note its **slug** (from the URL: `linear.app/team/project/<slug>`)
2. Create a Linear API key at Settings > API
3. Set `LINEAR_API_KEY` in your environment
4. Configure `tracker.project_slug` in WORKFLOW.md

### How Polling Works

Each tick (default every 30s):

1. **Reconcile** running sessions: refresh issue states from Linear, terminate agents whose issues moved to terminal states, detect stalled sessions
2. **Fetch candidates**: query Linear for issues in `active_states` within the configured project
3. **Sort**: by priority (ascending, lower = higher priority), then by creation date (oldest first), then by identifier
4. **Dispatch**: for each candidate that passes filters, launch an agent if slots are available

### Candidate Filters

An issue is dispatched only if:

- It has a valid id, identifier, title, and state
- Its state is in `active_states` and not in `terminal_states`
- It is not already running or claimed
- Global and per-state concurrency limits are not exceeded
- If `trigger_labels` is non-empty, the issue has at least one matching label
- For issues in "Todo" state: no non-terminal blockers exist

### Blocker Handling

Issues in the "Todo" state are held back if they have blocking relations where the blocker issue is not in a terminal state. This is extracted from Linear's `inverseRelations` where `type === "blocks"`.

## Agent Providers

### Codex (JSON-RPC over stdio)

The Codex provider spawns a `codex app-server` process and communicates via JSON-RPC 2.0 over stdin/stdout.

Session lifecycle:
1. `initialize` handshake
2. `initialized` notification
3. `thread/start` to create a conversation thread
4. For each turn: `turn/start` with the rendered prompt, then stream events until `turn/completed`, `turn/failed`, or `turn/cancelled`
5. Approval requests (`item/approval/request`, `item/command/approval`, `item/file_change/approval`) are auto-approved
6. `item/tool/call` for `linear_graphql` is handled as a dynamic tool: the query is forwarded to the Linear API and the result returned to Codex

### Claude (Claude Agent SDK)

The Claude provider uses `@anthropic-ai/claude-agent-sdk` to run agent sessions via the `query()` function.

Session lifecycle:
1. Call `query()` with the model, prompt, workspace directory, and max turns
2. Stream `onMessage` callbacks for tool use notifications and token usage
3. Returns when the query completes or times out

### Routing

Issues are routed to providers based on label-matching rules defined in `routing.rules`. Rules are evaluated in order; the first rule whose labels intersect with the issue's labels determines the provider. If no rule matches, `agent.default_provider` is used.

## Workspace Management

Each issue gets an isolated workspace directory under `workspace.root`, named by sanitizing the issue identifier (only `[A-Za-z0-9._-]` characters are kept).

### Lifecycle

1. **Create**: directory is created if it doesn't exist. `after_create` hook runs (e.g. to `git clone`). If the hook fails, the directory is removed.
2. **Before run**: `before_run` hook runs before each agent session (e.g. to `git pull`).
3. **After run**: `after_run` hook runs after each session ends. Failures are logged but ignored.
4. **Cleanup**: when an issue reaches a terminal state, `before_remove` runs, then the directory is deleted.

### Path Safety

Workspace paths are validated to ensure they are under `workspace.root`. Path traversal attacks (e.g. `../../etc`) are blocked.

## Prompt Templates

The body of WORKFLOW.md (after the YAML front matter) is a [LiquidJS](https://liquidjs.com/) template rendered with strict variable mode.

### Available Variables

| Variable | Type | Description |
|---|---|---|
| `issue.id` | string | Linear issue UUID |
| `issue.identifier` | string | Human-readable ID (e.g. `PRJ-123`) |
| `issue.title` | string | Issue title |
| `issue.description` | string | Issue description (empty string if null) |
| `issue.priority` | number \| null | Priority (0 = none, 1 = urgent, 4 = low) |
| `issue.state` | string | Current state name |
| `issue.branch_name` | string | Suggested branch name (empty if null) |
| `issue.url` | string | Linear issue URL (empty if null) |
| `issue.labels` | string | Comma-separated label names |
| `issue.blocked_by` | array | Array of `{ id, identifier, state }` blocker objects |
| `issue.created_at` | string | ISO 8601 timestamp |
| `issue.updated_at` | string | ISO 8601 timestamp |
| `attempt` | number \| null | Retry attempt number (null for first run) |
| `default_branch` | string | From `workspace.default_branch` config |
| `language` | string | From `agent.language` config |

### Example

```liquid
You are an autonomous coding agent working on {{ issue.identifier }}: {{ issue.title }}.

## Task
{{ issue.description }}

## Instructions
- Work on branch `{{ issue.branch_name }}` based off `{{ default_branch }}`
- Respond in {{ language }}
{% if attempt %}
- This is retry attempt {{ attempt }}. Review previous work before continuing.
{% endif %}
```

## Dynamic Reload

WORKFLOW.md is watched for changes using `chokidar`. When the file changes:

1. The new content is parsed and validated
2. If valid, the orchestrator's config and prompt template are hot-reloaded
3. If invalid, the current config is kept and an error is logged

No restart is needed for config changes.

## Monitoring & Observability

### HTTP Dashboard

When `server.port` is configured (or `--port` is passed), an HTTP server starts on `127.0.0.1`.

#### `GET /` - Dashboard

Auto-refreshing HTML dashboard (every 5s) showing:
- Running session count, retry count, total tokens, runtime
- Running sessions table: issue, state, turns, last event, message, tokens, start time
- Retry queue table: issue, attempt, due time, error

#### `GET /api/v1/state` - JSON State

Full orchestrator state as JSON:

```json
{
  "generated_at": "2026-03-07T12:00:00.000Z",
  "counts": { "running": 2, "retrying": 1 },
  "running": [
    {
      "issue_id": "...",
      "issue_identifier": "PRJ-123",
      "state": "In Progress",
      "session_id": "...",
      "turn_count": 3,
      "last_event": "turn_completed",
      "last_message": "",
      "started_at": "...",
      "tokens": { "input_tokens": 1000, "output_tokens": 500, "total_tokens": 1500 }
    }
  ],
  "retrying": [
    {
      "issue_id": "...",
      "issue_identifier": "PRJ-456",
      "attempt": 2,
      "due_at": "...",
      "error": "turn_timeout"
    }
  ],
  "agent_totals": {
    "input_tokens": 50000,
    "output_tokens": 25000,
    "total_tokens": 75000,
    "seconds_running": 3600.5
  },
  "rate_limits": null
}
```

#### `GET /api/v1/<identifier>` - Issue Detail

Returns running/retry details for a specific issue identifier.

#### `POST /api/v1/refresh` - Trigger Poll

Forces an immediate poll cycle. Returns `202 Accepted`:

```json
{
  "queued": true,
  "coalesced": false,
  "requested_at": "...",
  "operations": ["poll", "reconcile"]
}
```

### Logging

Structured log output to stdout/stderr in the format:

```
2026-03-07T12:00:00.000Z [INFO] Dispatching issue issueIdentifier=PRJ-123 state=Todo
```

Log levels: `debug`, `info`, `warn`, `error`. Default is `info`. Use `--debug` for verbose output.

## Retry & Recovery

When an agent session exits:

- **Normal exit**: a short continuation retry (1s delay) is scheduled to check if the issue is still active and re-dispatch if needed
- **Error exit**: exponential backoff retry is scheduled (`10s * 2^(attempt-1)`, capped at `max_retry_backoff_ms`)

On retry, the issue is re-fetched from Linear. If it's no longer in an active state, the claim is released.

## Reconciliation

Each poll tick runs reconciliation before dispatching new work:

1. **Stall detection**: sessions with no agent events for longer than `stall_timeout_ms` are terminated
2. **State refresh**: running issues are re-fetched from Linear by ID
3. **Terminal cleanup**: issues that moved to terminal states have their agents stopped and workspaces cleaned up
4. **Inactive cleanup**: issues that left active states (but aren't terminal) have their agents stopped

At startup, workspaces for issues already in terminal states are cleaned up.

## Testing

```bash
bun test              # Run all tests
bun run typecheck     # TypeScript type checking (tsc --noEmit)
bun run check         # Both: typecheck + test
```

Test files are in `ts/test/`:
- `workflow.test.ts` - WORKFLOW.md parsing
- `config.test.ts` - Configuration building and validation
- `prompt.test.ts` - LiquidJS template rendering
- `workspace.test.ts` - Workspace creation and hooks
- `orchestrator.test.ts` - Poll loop, dispatch, reconciliation
- `providers.test.ts` - Agent provider routing

## Architecture

```
ts/
  src/
    main.ts                  CLI entry point, arg parsing, startup
    types.ts                 Core domain types (Issue, RunningEntry, AgentEvent, etc.)
    config.ts                YAML config -> typed ServiceConfig with defaults
    workflow.ts              WORKFLOW.md loader (YAML front matter + prompt body)
    prompt.ts                LiquidJS template renderer
    orchestrator.ts          Poll loop, dispatch, reconciliation, retry
    watcher.ts               chokidar file watcher for dynamic reload
    server.ts                HTTP dashboard and JSON API
    logger.ts                Structured logging to stdout/stderr
    workspace/
      manager.ts             Per-issue workspace lifecycle and hooks
    providers/
      registry.ts            Provider registry and label-based routing
      codex.ts               Codex app-server provider (JSON-RPC over stdio)
      claude.ts              Claude Agent SDK provider
    linear/
      client.ts              Linear GraphQL client (candidate fetch, state refresh)
  test/
    workflow.test.ts
    config.test.ts
    prompt.test.ts
    workspace.test.ts
    orchestrator.test.ts
    providers.test.ts
  package.json
  tsconfig.json
```

### Data Flow

```
WORKFLOW.md
    |
    v
[Workflow Loader] ---> [Config Builder] ---> ServiceConfig
    |                                             |
    v                                             v
Prompt Template                            [Orchestrator]
                                                |
                           +--------------------+--------------------+
                           |                    |                    |
                     [Linear Client]    [Provider Registry]  [Workspace Manager]
                           |                    |                    |
                     Poll for issues    Route to provider     Create/cleanup dirs
                                                |                    |
                                    +-----------+-----------+   Run hooks
                                    |                       |
                              [Codex Provider]      [Claude Provider]
                              JSON-RPC stdio        Agent SDK query()
```

## License

See [LICENSE](../LICENSE) in the project root.
