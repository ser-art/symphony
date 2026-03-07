// Symphony TypeScript - Codex App Server Provider (Section 10.1-10.7)
// JSON-RPC 2.0 over stdio communication with codex app-server

import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { logger } from "../logger";
import type { CodexConfig, TrackerConfig } from "../config";
import type {
  AgentProvider,
  AgentSession,
  SessionParams,
  AgentEvent,
  TurnResult,
} from "../types";

export class CodexProvider implements AgentProvider {
  name = "codex";
  kind = "codex_app_server" as const;

  constructor(
    private config: CodexConfig,
    private trackerConfig: TrackerConfig,
  ) {}

  async startSession(params: SessionParams): Promise<AgentSession> {
    return CodexSession.create(
      this.config,
      this.trackerConfig,
      params,
    );
  }
}

let requestIdCounter = 0;
function nextId(): number {
  return ++requestIdCounter;
}

class CodexSession implements AgentSession {
  private proc: ChildProcess;
  private rl: ReadlineInterface;
  private pendingRequests = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private config: CodexConfig;
  private trackerConfig: TrackerConfig;
  private params: SessionParams;
  threadId: string | null = null;
  private alive = true;

  private constructor(
    proc: ChildProcess,
    rl: ReadlineInterface,
    config: CodexConfig,
    trackerConfig: TrackerConfig,
    params: SessionParams,
  ) {
    this.proc = proc;
    this.rl = rl;
    this.config = config;
    this.trackerConfig = trackerConfig;
    this.params = params;
  }

  static async create(
    config: CodexConfig,
    trackerConfig: TrackerConfig,
    params: SessionParams,
  ): Promise<CodexSession> {
    const proc = spawn("bash", ["-lc", config.command], {
      cwd: params.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (!proc.pid) {
      throw new Error("codex_not_found: Failed to spawn codex app-server");
    }

    const rl = createInterface({ input: proc.stdout! });

    const session = new CodexSession(proc, rl, config, trackerConfig, params);

    // Handle stderr (diagnostics only)
    proc.stderr?.on("data", (data) => {
      const line = data.toString().trim();
      if (line) {
        logger.debug("codex stderr", {
          issueIdentifier: params.issue.identifier,
          stderr: line.slice(0, 500),
        });
      }
    });

    proc.on("exit", (code) => {
      session.alive = false;
      // Reject all pending requests
      for (const [, pending] of session.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`port_exit: codex exited with code ${code}`));
      }
      session.pendingRequests.clear();
    });

    // Listen for abort
    params.signal.addEventListener("abort", () => {
      session.stop();
    });

    // Handshake
    await session.handshake();

    return session;
  }

  private async handshake(): Promise<void> {
    // 1. initialize
    const initResult = await this.request("initialize", {
      clientInfo: { name: "symphony", version: "1.0" },
      capabilities: {},
    });
    logger.debug("codex initialize response", { result: JSON.stringify(initResult) });

    // 2. initialized notification
    this.send({ method: "initialized", params: {} });

    // 3. thread/start
    const threadResult = await this.request("thread/start", {
      approvalPolicy: this.config.approvalPolicy,
      sandbox: this.config.threadSandbox,
      cwd: this.params.workspacePath,
    });

    this.threadId = threadResult?.thread?.id ?? threadResult?.result?.thread?.id ?? null;
    if (!this.threadId) {
      throw new Error("response_error: No thread ID in thread/start response");
    }
  }

  async runTurn(prompt: string): Promise<TurnResult> {
    if (!this.alive) {
      return { status: "failed", error: "port_exit: process not alive" };
    }

    const issue = this.params.issue;
    const turnStartId = nextId();

    // Start turn
    this.send({
      id: turnStartId,
      method: "turn/start",
      params: {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
        cwd: this.params.workspacePath,
        title: `${issue.identifier}: ${issue.title}`,
        approvalPolicy: this.config.approvalPolicy,
        sandboxPolicy: this.config.turnSandboxPolicy,
      },
    });

    // Stream turn events
    return this.streamTurn(turnStartId);
  }

  private streamTurn(turnStartId: number): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      let turnId: string | null = null;
      const turnTimeout = setTimeout(() => {
        resolve({ status: "failed", error: "turn_timeout" });
      }, this.config.turnTimeoutMs);

      const lineHandler = (line: string) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          this.emitEvent("malformed", `Non-JSON line: ${line.slice(0, 200)}`);
          return;
        }

        // Handle request responses (for turn/start)
        if (msg.id === turnStartId && msg.result) {
          turnId =
            msg.result?.turn?.id ?? msg.result?.id ?? null;
          const sessionId = this.threadId && turnId
            ? `${this.threadId}-${turnId}`
            : null;

          this.emitEvent("session_started", null, {
            sessionId,
            threadId: this.threadId,
            turnId,
            agentProcessPid: String(this.proc.pid ?? ""),
          });
          return;
        }

        // Handle protocol errors
        if (msg.id === turnStartId && msg.error) {
          clearTimeout(turnTimeout);
          this.rl.off("line", lineHandler);
          resolve({
            status: "failed",
            error: `response_error: ${msg.error?.message ?? JSON.stringify(msg.error)}`,
          });
          return;
        }

        // Handle turn completion methods
        const method = msg.method ?? "";

        if (method === "turn/completed") {
          clearTimeout(turnTimeout);
          this.rl.off("line", lineHandler);
          this.extractUsage(msg);
          this.emitEvent("turn_completed");
          resolve({ status: "completed" });
          return;
        }

        if (method === "turn/failed") {
          clearTimeout(turnTimeout);
          this.rl.off("line", lineHandler);
          this.emitEvent("turn_failed", msg.params?.error ?? "turn failed");
          resolve({
            status: "failed",
            error: `turn_failed: ${msg.params?.error ?? "unknown"}`,
          });
          return;
        }

        if (method === "turn/cancelled") {
          clearTimeout(turnTimeout);
          this.rl.off("line", lineHandler);
          this.emitEvent("turn_cancelled");
          resolve({ status: "cancelled" });
          return;
        }

        // Approval requests - auto-approve
        if (
          method === "item/approval/request" ||
          method === "item/command/approval" ||
          method === "item/file_change/approval"
        ) {
          const approvalId = msg.params?.id ?? msg.id;
          if (approvalId) {
            this.send({ id: approvalId, result: { approved: true } });
            this.emitEvent("approval_auto_approved", method);
          }
          return;
        }

        // User input required - hard fail
        if (
          method === "item/tool/requestUserInput" ||
          (msg.params?.turnComplete === false && msg.params?.inputRequired)
        ) {
          clearTimeout(turnTimeout);
          this.rl.off("line", lineHandler);
          this.emitEvent("turn_input_required");
          resolve({ status: "input_required" });
          return;
        }

        // Dynamic tool calls
        if (method === "item/tool/call") {
          this.handleToolCall(msg);
          return;
        }

        // Token usage updates
        if (
          method === "thread/tokenUsage/updated" ||
          method === "token_usage"
        ) {
          this.extractUsage(msg);
          return;
        }

        // Rate limit updates
        if (method === "rate_limit" || method === "thread/rateLimit/updated") {
          this.emitEvent("other_message", null, {
            rateLimits: msg.params ?? msg,
          });
          return;
        }

        // Generic notifications
        this.emitEvent("notification", this.summarizeEvent(msg));
      };

      this.rl.on("line", lineHandler);

      // Handle process exit during turn
      this.proc.once("exit", () => {
        clearTimeout(turnTimeout);
        this.rl.off("line", lineHandler);
        resolve({ status: "failed", error: "port_exit" });
      });
    });
  }

  private handleToolCall(msg: any): void {
    const toolName = msg.params?.name ?? msg.params?.tool?.name ?? "";
    const callId = msg.params?.id ?? msg.id;

    if (toolName === "linear_graphql" && this.trackerConfig.kind === "linear") {
      this.handleLinearGraphQL(callId, msg.params?.arguments ?? msg.params?.input ?? {});
      return;
    }

    // Unsupported tool
    this.emitEvent("unsupported_tool_call", `Unsupported tool: ${toolName}`);
    if (callId) {
      this.send({
        id: callId,
        result: { success: false, error: "unsupported_tool_call" },
      });
    }
  }

  private async handleLinearGraphQL(
    callId: string | number,
    input: any,
  ): Promise<void> {
    try {
      const query =
        typeof input === "string" ? input : input?.query;
      if (!query || typeof query !== "string") {
        this.send({
          id: callId,
          result: { success: false, error: "invalid input: query is required" },
        });
        return;
      }

      const variables = input?.variables;

      const response = await fetch(this.trackerConfig.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.trackerConfig.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        this.send({
          id: callId,
          result: {
            success: false,
            error: `Linear API returned ${response.status}`,
          },
        });
        return;
      }

      const body = (await response.json()) as { data?: unknown; errors?: unknown[] };

      if (body.errors && body.errors.length > 0) {
        this.send({
          id: callId,
          result: { success: false, data: body.data, errors: body.errors },
        });
      } else {
        this.send({
          id: callId,
          result: { success: true, data: body.data },
        });
      }
    } catch (e) {
      this.send({
        id: callId,
        result: {
          success: false,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  private extractUsage(msg: any): void {
    const params = msg.params ?? msg;
    const usage =
      params.total_token_usage ??
      params.tokenUsage ??
      params.usage ??
      params;

    const inputTokens =
      usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0;
    const outputTokens =
      usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0;
    const totalTokens =
      usage.total_tokens ?? usage.totalTokens ?? inputTokens + outputTokens;

    if (totalTokens > 0) {
      this.emitEvent("other_message", null, {
        usage: { inputTokens, outputTokens, totalTokens },
      });
    }
  }

  private summarizeEvent(msg: any): string {
    const method = msg.method ?? "";
    if (method.startsWith("item/")) {
      const type = msg.params?.type ?? msg.params?.item?.type ?? "";
      return `${method} ${type}`.trim();
    }
    return method || "message";
  }

  private emitEvent(
    event: string,
    message?: string | null,
    extra?: Record<string, unknown>,
  ): void {
    this.params.onEvent({
      event: event as any,
      timestamp: new Date(),
      agentProcessPid: String(this.proc.pid ?? ""),
      message: message ?? undefined,
      ...(extra?.usage ? { usage: extra.usage as any } : {}),
      payload: extra,
    });
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.alive || !this.proc.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = nextId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`response_timeout: ${method} timed out`));
      }, this.config.readTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send({ id, method, params });

      // Listen for response
      const lineHandler = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            this.rl.off("line", lineHandler);
            const pending = this.pendingRequests.get(id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingRequests.delete(id);
              if (msg.error) {
                pending.reject(
                  new Error(
                    `response_error: ${msg.error.message ?? JSON.stringify(msg.error)}`,
                  ),
                );
              } else {
                pending.resolve(msg.result ?? msg);
              }
            }
          }
        } catch {
          // Not JSON, ignore
        }
      };
      this.rl.on("line", lineHandler);
    });
  }

  async stop(): Promise<void> {
    this.alive = false;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Session stopped"));
    }
    this.pendingRequests.clear();

    if (this.proc.pid && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      // Give it a moment to exit gracefully
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!this.proc.killed) this.proc.kill("SIGKILL");
          resolve();
        }, 5000);
        this.proc.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
