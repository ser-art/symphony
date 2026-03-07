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

    try {
      const turnTimeout = AbortSignal.timeout(this.config.turnTimeoutMs);
      const combinedSignal = AbortSignal.any([
        this.params.signal,
        turnTimeout,
      ]);

      const result = await query({
        model: this.config.model,
        prompt,
        workingDirectory: this.params.workspacePath,
        maxTurns: this.config.maxTurns,
        permissionMode: this.config.permissionMode as any,
        abortSignal: combinedSignal,
        onMessage: (message: any) => {
          this.handleMessage(message);
        },
      });

      // Extract final result
      if (result?.error) {
        this.emitEvent("turn_failed", result.error);
        return { status: "failed", error: result.error };
      }

      this.emitEvent("turn_completed");
      return { status: "completed" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("abort") || msg.includes("timeout")) {
        this.emitEvent("turn_failed", "turn_timeout");
        return { status: "failed", error: "turn_timeout" };
      }
      this.emitEvent("turn_failed", msg);
      return { status: "failed", error: msg };
    }
  }

  private handleMessage(message: any): void {
    if (!message) return;

    const type = message.type ?? "";

    // Tool use notifications
    if (type === "tool_use" || type === "tool_result") {
      const toolName = message.name ?? message.tool_name ?? "";
      this.emitEvent("notification", `tool: ${toolName}`);
    }

    // Result messages
    if (type === "result") {
      if (message.subtype === "error" || message.error) {
        this.emitEvent(
          "turn_ended_with_error",
          message.error ?? "result error",
        );
      }
    }

    // Token usage
    if (message.usage) {
      const usage = message.usage;
      this.params.onEvent({
        event: "other_message",
        timestamp: new Date(),
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          totalTokens:
            (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        },
      });
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
  }
}
