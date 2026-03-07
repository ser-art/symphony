// Tests for provider registry and routing (Section 17.5)
import { describe, test, expect } from "bun:test";
import { ProviderRegistry } from "../src/providers/registry";
import { buildConfig } from "../src/config";
import type { Issue } from "../src/types";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "id-1",
    identifier: "TEST-1",
    title: "Test",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("Provider Registry", () => {
  const config = buildConfig({
    config: {
      tracker: { kind: "linear", project_slug: "test" },
    },
    promptTemplate: "test",
  });

  test("default provider is codex", () => {
    const registry = new ProviderRegistry(config);
    const provider = registry.resolveProvider(
      makeIssue(),
      [],
      "codex",
    );
    expect(provider.name).toBe("codex");
    expect(provider.kind).toBe("codex_app_server");
  });

  test("routing rule overrides provider", () => {
    const registry = new ProviderRegistry(config);
    const rules = [{ labels: ["claude"], provider: "claude" }];

    const claudeIssue = makeIssue({ labels: ["claude"] });
    const provider = registry.resolveProvider(claudeIssue, rules, "codex");
    expect(provider.name).toBe("claude");
  });

  test("unmatched routing falls back to default", () => {
    const registry = new ProviderRegistry(config);
    const rules = [{ labels: ["claude"], provider: "claude" }];

    const plainIssue = makeIssue({ labels: ["bug"] });
    const provider = registry.resolveProvider(plainIssue, rules, "codex");
    expect(provider.name).toBe("codex");
  });

  test("first matching rule wins", () => {
    const registry = new ProviderRegistry(config);
    const rules = [
      { labels: ["special"], provider: "claude" },
      { labels: ["special"], provider: "codex" },
    ];

    const issue = makeIssue({ labels: ["special"] });
    const provider = registry.resolveProvider(issue, rules, "codex");
    expect(provider.name).toBe("claude");
  });

  test("label matching is case-insensitive", () => {
    const registry = new ProviderRegistry(config);
    const rules = [{ labels: ["claude"], provider: "claude" }];

    const issue = makeIssue({ labels: ["Claude"] });
    const provider = registry.resolveProvider(issue, rules, "codex");
    expect(provider.name).toBe("claude");
  });
});
