// Symphony TypeScript - Claude Code Provider (Section 10.8)
// Uses @anthropic-ai/claude-agent-sdk for agent sessions

import { logger } from "../logger";
import type { ClaudeConfig } from "../config";
import type {
  AgentProvider,
  AgentSession,
  SessionParams,
  AgentEvent,
  TurnResult,
} from "../types";

export class ClaudeProvider implements AgentProvider {
  name = "claude";
  kind = "claude_agent_sdk" as const;

  constructor(private config: ClaudeConfig) {}

  async startSession(params: SessionParams): Promise<AgentSession> {
    return ClaudeSession.create(this.config, params);
  }
}

class ClaudeSession implements AgentSession {
  private config: ClaudeConfig;
  private params: SessionParams;
  threadId: string | null = null;
  private aborted = false;
  private activeQuery: { close(): void } | null = null;

  private constructor(config: ClaudeConfig, params: SessionParams) {
    this.config = config;
    this.params = params;
  }

  static async create(
    config: ClaudeConfig,
    params: SessionParams,
  ): Promise<ClaudeSession> {
    const session = new ClaudeSession(config, params);

    params.signal.addEventListener("abort", () => {
      session.aborted = true;
    });

    return session;
  }

  async runTurn(prompt: string): Promise<TurnResult> {
    if (this.aborted) {
      return { status: "failed", error: "Session aborted" };
    }

    // Dynamic import to handle optional dependency
    let claudeSDK: any;
    try {
      claudeSDK = await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      return {
        status: "failed",
        error: "claude-agent-sdk not available",
      };
    }

    const { query } = claudeSDK;

    const abortController = new AbortController();

    // Wire session signal into our controller
    const onAbort = () => abortController.abort();
    this.params.signal.addEventListener("abort", onAbort);

    // Turn timeout
    const turnTimer = setTimeout(
      () => abortController.abort(),
      this.config.turnTimeoutMs,
    );

    try {
      const q = query({
        prompt,
        options: {
          cwd: this.params.workspacePath,
          model: this.config.model,
          maxTurns: this.config.maxTurns,
          permissionMode: this.config.permissionMode as any,
          allowDangerouslySkipPermissions:
            this.config.permissionMode === "bypassPermissions",
          abortController,
          persistSession: false,
        },
      });

      this.activeQuery = q;

      for await (const message of q) {
        if (!message || !message.type) continue;

        switch (message.type) {
          case "system":
            if (message.subtype === "init" && message.session_id) {
              this.threadId = message.session_id;
              this.emitEvent("session_started");
            }
            break;

          case "assistant": {
            const usage = message.message?.usage;
            if (usage) {
              // BetaUsage uses snake_case: input_tokens, output_tokens
              const inputTokens = usage.input_tokens ?? 0;
              const outputTokens = usage.output_tokens ?? 0;
              this.params.onEvent({
                event: "other_message",
                timestamp: new Date(),
                usage: {
                  inputTokens,
                  outputTokens,
                  totalTokens: inputTokens + outputTokens,
                },
              });
            }
            break;
          }

          case "result": {
            if (message.subtype === "success") {
              this.emitEvent("turn_completed");
              return { status: "completed" };
            }
            // Error result
            const errorMsg =
              message.errors?.join("; ") ??
              message.subtype ??
              "agent error";
            this.emitEvent("turn_ended_with_error", errorMsg);
            return { status: "failed", error: errorMsg };
          }
        }
      }

      // Generator exhausted without result message
      this.emitEvent("turn_completed");
      return { status: "completed" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (this.aborted || msg.includes("abort") || msg.includes("Abort")) {
        this.emitEvent("turn_cancelled");
        return { status: "cancelled" };
      }
      this.emitEvent("turn_failed", msg);
      return { status: "failed", error: msg };
    } finally {
      clearTimeout(turnTimer);
      this.params.signal.removeEventListener("abort", onAbort);
      this.activeQuery = null;
    }
  }

  private emitEvent(event: string, message?: string): void {
    this.params.onEvent({
      event: event as any,
      timestamp: new Date(),
      message,
    });
  }

  async stop(): Promise<void> {
    this.aborted = true;
    this.activeQuery?.close();
  }
}
