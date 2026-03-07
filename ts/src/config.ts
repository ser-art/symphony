// Symphony TypeScript - Configuration Layer (Section 6)
// Typed config getters with defaults, $VAR resolution, ~ expansion

import { homedir, tmpdir } from "os";
import { resolve } from "path";
import type { WorkflowDefinition } from "./types";

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
  terminalStates: string[];
  triggerLabels: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
  defaultBranch: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Map<string, number>;
  language: string;
  defaultProvider: string;
  defaultSystem: string;
}

export interface CodexConfig {
  command: string;
  approvalPolicy: unknown;
  threadSandbox: string;
  turnSandboxPolicy: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface ClaudeConfig {
  model: string;
  maxTurns: number;
  permissionMode: string;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface RoutingRule {
  labels: string[];
  provider?: string;
  system?: string;
}

export interface RoutingConfig {
  rules: RoutingRule[];
}

export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  claude: ClaudeConfig;
  routing: RoutingConfig;
  serverPort: number | null;
}

function resolveEnvVar(value: string): string {
  if (value.startsWith("$")) {
    const varName = value.slice(1);
    return process.env[varName] ?? "";
  }
  return value;
}

function expandPath(value: string): string {
  if (value.startsWith("~")) {
    return resolve(homedir(), value.slice(2));
  }
  // Resolve $VAR for path values
  const resolved = resolveEnvVar(value);
  if (resolved.startsWith("~")) {
    return resolve(homedir(), resolved.slice(2));
  }
  return resolve(resolved);
}

function getStr(
  obj: Record<string, unknown>,
  key: string,
  def: string,
): string {
  const v = obj[key];
  if (v === undefined || v === null) return def;
  return String(v);
}

function getInt(
  obj: Record<string, unknown>,
  key: string,
  def: number,
): number {
  const v = obj[key];
  if (v === undefined || v === null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function getStringList(
  obj: Record<string, unknown>,
  key: string,
  def: string[],
): string[] {
  const v = obj[key];
  if (v === undefined || v === null) return def;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(",").map((s) => s.trim());
  return def;
}

function getObj(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const v = obj[key];
  if (v && typeof v === "object" && !Array.isArray(v))
    return v as Record<string, unknown>;
  return {};
}

export function buildConfig(workflow: WorkflowDefinition): ServiceConfig {
  const cfg = workflow.config;
  const tracker = getObj(cfg, "tracker");
  const polling = getObj(cfg, "polling");
  const workspace = getObj(cfg, "workspace");
  const hooks = getObj(cfg, "hooks");
  const agent = getObj(cfg, "agent");
  const codex = getObj(cfg, "codex");
  const claude = getObj(cfg, "claude");
  const routing = getObj(cfg, "routing");
  const server = getObj(cfg, "server");

  // Tracker
  const trackerKind = getStr(tracker, "kind", "");
  const trackerEndpoint =
    trackerKind === "linear"
      ? getStr(tracker, "endpoint", "https://api.linear.app/graphql")
      : getStr(tracker, "endpoint", "");

  let apiKey = getStr(tracker, "api_key", "$LINEAR_API_KEY");
  apiKey = resolveEnvVar(apiKey);

  // Workspace root
  const rawRoot = getStr(
    workspace,
    "root",
    `${tmpdir()}/symphony_workspaces`,
  );
  const workspaceRoot = expandPath(rawRoot);

  // Per-state concurrency
  const byStateRaw = getObj(agent, "max_concurrent_agents_by_state");
  const byState = new Map<string, number>();
  for (const [k, v] of Object.entries(byStateRaw)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      byState.set(k.trim().toLowerCase(), Math.floor(n));
    }
  }

  // Hooks timeout
  const hooksTimeoutMs = getInt(hooks, "timeout_ms", 60000);

  // Routing rules
  const routingRules: RoutingRule[] = [];
  const rawRules = routing.rules;
  if (Array.isArray(rawRules)) {
    for (const r of rawRules) {
      if (r && typeof r === "object" && !Array.isArray(r)) {
        const rule = r as Record<string, unknown>;
        const labels = getStringList(rule, "labels", []).map((l) =>
          l.trim().toLowerCase(),
        );
        const provider = rule.provider ? String(rule.provider) : undefined;
        const system = rule.system ? String(rule.system) : undefined;
        if (labels.length > 0 && (provider || system)) {
          routingRules.push({ labels, provider, system });
        }
      }
    }
  }

  // Server port
  let serverPort: number | null = null;
  const portVal = server.port;
  if (portVal !== undefined && portVal !== null) {
    const n = Number(portVal);
    if (Number.isFinite(n) && n >= 0) serverPort = Math.floor(n);
  }

  return {
    tracker: {
      kind: trackerKind,
      endpoint: trackerEndpoint,
      apiKey,
      projectSlug: getStr(tracker, "project_slug", ""),
      activeStates: getStringList(tracker, "active_states", [
        "Todo",
        "In Progress",
      ]),
      terminalStates: getStringList(tracker, "terminal_states", [
        "Closed",
        "Cancelled",
        "Canceled",
        "Duplicate",
        "Done",
      ]),
      triggerLabels: getStringList(tracker, "trigger_labels", []).map((l) =>
        l.trim().toLowerCase(),
      ),
    },
    polling: {
      intervalMs: getInt(polling, "interval_ms", 30000),
    },
    workspace: {
      root: workspaceRoot,
      defaultBranch: getStr(workspace, "default_branch", "dev"),
    },
    hooks: {
      afterCreate: (hooks.after_create as string) ?? null,
      beforeRun: (hooks.before_run as string) ?? null,
      afterRun: (hooks.after_run as string) ?? null,
      beforeRemove: (hooks.before_remove as string) ?? null,
      timeoutMs: hooksTimeoutMs > 0 ? hooksTimeoutMs : 60000,
    },
    agent: {
      maxConcurrentAgents: getInt(agent, "max_concurrent_agents", 10),
      maxTurns: getInt(agent, "max_turns", 20),
      maxRetryBackoffMs: getInt(agent, "max_retry_backoff_ms", 300000),
      maxConcurrentAgentsByState: byState,
      language: getStr(agent, "language", "ru"),
      defaultProvider: getStr(agent, "default_provider", "codex"),
      defaultSystem: getStr(agent, "default_system", "simple"),
    },
    codex: {
      command: getStr(codex, "command", "codex app-server"),
      approvalPolicy: codex.approval_policy ?? "never",
      threadSandbox: getStr(codex, "thread_sandbox", "workspace-write"),
      turnSandboxPolicy: codex.turn_sandbox_policy ?? {
        type: "workspaceWrite",
      },
      turnTimeoutMs: getInt(codex, "turn_timeout_ms", 3600000),
      readTimeoutMs: getInt(codex, "read_timeout_ms", 5000),
      stallTimeoutMs: getInt(codex, "stall_timeout_ms", 300000),
    },
    claude: {
      model: getStr(claude, "model", "claude-sonnet-4-6"),
      maxTurns: getInt(claude, "max_turns", 20),
      permissionMode: getStr(
        claude,
        "permission_mode",
        "dangerouslySkipPermissions",
      ),
      turnTimeoutMs: getInt(claude, "turn_timeout_ms", 3600000),
      stallTimeoutMs: getInt(claude, "stall_timeout_ms", 300000),
    },
    routing: {
      rules: routingRules,
    },
    serverPort,
  };
}

// Section 6.3 - Dispatch Preflight Validation
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateDispatchConfig(config: ServiceConfig): ValidationResult {
  const errors: string[] = [];

  if (!config.tracker.kind) {
    errors.push("tracker.kind is required");
  } else if (config.tracker.kind !== "linear") {
    errors.push(`Unsupported tracker kind: ${config.tracker.kind}`);
  }

  if (!config.tracker.apiKey) {
    errors.push("tracker.api_key is required (after $VAR resolution)");
  }

  if (config.tracker.kind === "linear" && !config.tracker.projectSlug) {
    errors.push("tracker.project_slug is required for linear tracker");
  }

  // At least one provider must be valid
  const defaultProvider = config.agent.defaultProvider;
  if (defaultProvider === "codex") {
    if (!config.codex.command) {
      errors.push("codex.command is required when using codex provider");
    }
  } else if (defaultProvider === "claude") {
    if (!config.claude.model) {
      errors.push("claude.model is required when using claude provider");
    }
  } else {
    errors.push(
      `agent.default_provider must reference codex or claude, got: ${defaultProvider}`,
    );
  }

  return { ok: errors.length === 0, errors };
}
