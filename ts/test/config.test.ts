// Tests for config layer (Section 17.1)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { buildConfig, validateDispatchConfig } from "../src/config";
import type { WorkflowDefinition } from "../src/types";

function makeWorkflow(
  config: Record<string, unknown> = {},
): WorkflowDefinition {
  return { config, promptTemplate: "test prompt" };
}

describe("Config Layer", () => {
  test("applies defaults when optional values missing", () => {
    const cfg = buildConfig(makeWorkflow());
    expect(cfg.polling.intervalMs).toBe(30000);
    expect(cfg.agent.maxConcurrentAgents).toBe(10);
    expect(cfg.agent.maxTurns).toBe(20);
    expect(cfg.agent.maxRetryBackoffMs).toBe(300000);
    expect(cfg.agent.language).toBe("ru");
    expect(cfg.agent.defaultProvider).toBe("codex");
    expect(cfg.agent.defaultSystem).toBe("simple");
    expect(cfg.codex.command).toBe("codex app-server");
    expect(cfg.codex.turnTimeoutMs).toBe(3600000);
    expect(cfg.codex.stallTimeoutMs).toBe(300000);
    expect(cfg.claude.model).toBe("claude-sonnet-4-6");
    expect(cfg.workspace.defaultBranch).toBe("dev");
    expect(cfg.hooks.timeoutMs).toBe(60000);
  });

  test("reads tracker config correctly", () => {
    const cfg = buildConfig(
      makeWorkflow({
        tracker: {
          kind: "linear",
          project_slug: "my-project",
          active_states: ["Todo", "In Progress", "Rework"],
          terminal_states: ["Done", "Closed"],
          trigger_labels: ["Symphony", "Auto"],
        },
      }),
    );

    expect(cfg.tracker.kind).toBe("linear");
    expect(cfg.tracker.projectSlug).toBe("my-project");
    expect(cfg.tracker.activeStates).toEqual([
      "Todo",
      "In Progress",
      "Rework",
    ]);
    expect(cfg.tracker.terminalStates).toEqual(["Done", "Closed"]);
    expect(cfg.tracker.triggerLabels).toEqual(["symphony", "auto"]);
  });

  test("resolves $VAR for api_key", () => {
    const originalKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "test-key-123";

    const cfg = buildConfig(
      makeWorkflow({ tracker: { api_key: "$LINEAR_API_KEY" } }),
    );
    expect(cfg.tracker.apiKey).toBe("test-key-123");

    if (originalKey !== undefined) {
      process.env.LINEAR_API_KEY = originalKey;
    } else {
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("per-state concurrency normalizes keys and ignores invalid", () => {
    const cfg = buildConfig(
      makeWorkflow({
        agent: {
          max_concurrent_agents_by_state: {
            "In Progress": 3,
            "  Todo  ": 2,
            Invalid: -1,
            Zero: 0,
            Bad: "not a number",
          },
        },
      }),
    );

    expect(cfg.agent.maxConcurrentAgentsByState.get("in progress")).toBe(3);
    expect(cfg.agent.maxConcurrentAgentsByState.get("todo")).toBe(2);
    expect(cfg.agent.maxConcurrentAgentsByState.has("invalid")).toBe(false);
    expect(cfg.agent.maxConcurrentAgentsByState.has("zero")).toBe(false);
  });

  test("routing rules parsed correctly", () => {
    const cfg = buildConfig(
      makeWorkflow({
        routing: {
          rules: [
            { labels: ["claude"], provider: "claude" },
            { labels: ["codex"], provider: "codex" },
            { labels: ["deep-review"], system: "implement-and-review" },
          ],
        },
      }),
    );

    expect(cfg.routing.rules).toHaveLength(3);
    expect(cfg.routing.rules[0]).toEqual({
      labels: ["claude"],
      provider: "claude",
    });
  });

  test("hooks config preserves null for missing hooks", () => {
    const cfg = buildConfig(
      makeWorkflow({
        hooks: { after_create: "git clone ." },
      }),
    );

    expect(cfg.hooks.afterCreate).toBe("git clone .");
    expect(cfg.hooks.beforeRun).toBeNull();
    expect(cfg.hooks.afterRun).toBeNull();
    expect(cfg.hooks.beforeRemove).toBeNull();
  });

  test("non-positive hooks.timeout_ms falls back to default", () => {
    const cfg = buildConfig(makeWorkflow({ hooks: { timeout_ms: -100 } }));
    expect(cfg.hooks.timeoutMs).toBe(60000);
  });

  test("codex.command preserved as shell string", () => {
    const cfg = buildConfig(
      makeWorkflow({
        codex: {
          command: 'codex --model gpt-5 app-server "$EXTRA_ARGS"',
        },
      }),
    );
    expect(cfg.codex.command).toBe(
      'codex --model gpt-5 app-server "$EXTRA_ARGS"',
    );
  });

  test("server.port parsed from config", () => {
    const cfg = buildConfig(makeWorkflow({ server: { port: 8080 } }));
    expect(cfg.serverPort).toBe(8080);
  });
});

describe("Dispatch Validation", () => {
  test("validates tracker.kind is required", () => {
    const cfg = buildConfig(makeWorkflow());
    const result = validateDispatchConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("tracker.kind"))).toBe(true);
  });

  test("validates unsupported tracker kind", () => {
    const cfg = buildConfig(
      makeWorkflow({ tracker: { kind: "jira" } }),
    );
    const result = validateDispatchConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Unsupported"))).toBe(true);
  });

  test("validates api_key is required", () => {
    const original = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    const cfg = buildConfig(
      makeWorkflow({
        tracker: { kind: "linear", project_slug: "test", api_key: "" },
      }),
    );
    const result = validateDispatchConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("api_key"))).toBe(true);

    if (original !== undefined) process.env.LINEAR_API_KEY = original;
  });

  test("validates project_slug for linear", () => {
    const original = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "test-key";

    const cfg = buildConfig(
      makeWorkflow({ tracker: { kind: "linear" } }),
    );
    const result = validateDispatchConfig(cfg);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("project_slug"))).toBe(true);

    if (original !== undefined) {
      process.env.LINEAR_API_KEY = original;
    } else {
      delete process.env.LINEAR_API_KEY;
    }
  });

  test("passes with valid config", () => {
    const original = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "test-key";

    const cfg = buildConfig(
      makeWorkflow({
        tracker: { kind: "linear", project_slug: "test-proj" },
      }),
    );
    const result = validateDispatchConfig(cfg);
    expect(result.ok).toBe(true);

    if (original !== undefined) {
      process.env.LINEAR_API_KEY = original;
    } else {
      delete process.env.LINEAR_API_KEY;
    }
  });
});
