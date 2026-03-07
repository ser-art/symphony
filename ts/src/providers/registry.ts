// Symphony TypeScript - Provider Registry (Section 3.1.7)
// Manages available agent providers and routes issues to providers

import type { ServiceConfig, RoutingRule } from "../config";
import type { AgentProvider, Issue } from "../types";
import { CodexProvider } from "./codex";
import { ClaudeProvider } from "./claude";

export class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();

  constructor(config: ServiceConfig) {
    // Register Codex provider
    this.providers.set(
      "codex",
      new CodexProvider(config.codex, config.tracker),
    );

    // Register Claude provider
    this.providers.set("claude", new ClaudeProvider(config.claude));
  }

  update(config: ServiceConfig): void {
    this.providers.set(
      "codex",
      new CodexProvider(config.codex, config.tracker),
    );
    this.providers.set("claude", new ClaudeProvider(config.claude));
  }

  getProvider(name: string): AgentProvider | undefined {
    return this.providers.get(name);
  }

  // Section 5.3.8 - Route issue to provider based on routing rules
  resolveProvider(
    issue: Issue,
    rules: RoutingRule[],
    defaultProvider: string,
  ): AgentProvider {
    // Evaluate routing rules in order; first match wins
    for (const rule of rules) {
      const issueLabels = issue.labels.map((l) => l.trim().toLowerCase());
      const matched = rule.labels.some((rl) => issueLabels.includes(rl));
      if (matched && rule.provider) {
        const provider = this.providers.get(rule.provider);
        if (provider) return provider;
      }
    }

    // Fallback to default
    const provider = this.providers.get(defaultProvider);
    if (!provider) {
      throw new Error(
        `Default provider "${defaultProvider}" not found in registry`,
      );
    }
    return provider;
  }
}
