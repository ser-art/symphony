// Symphony TypeScript - Core Domain Types
// Based on SPEC.md Section 4: Core Domain Model

// 4.1.1 Issue
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

// 4.1.2 Workflow Definition
export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

// 4.1.5 Run Attempt
export type RunStatus =
  | "preparing_workspace"
  | "building_prompt"
  | "launching_agent"
  | "initializing_session"
  | "streaming_turn"
  | "finishing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stalled"
  | "canceled_by_reconciliation";

// 4.1.6 Live Session
export interface LiveSession {
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  agentProcessPid: string | null;
  lastAgentEvent: string | null;
  lastAgentTimestamp: Date | null;
  lastAgentMessage: string | null;
  agentInputTokens: number;
  agentOutputTokens: number;
  agentTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
}

// 4.1.7 Retry Entry
export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: ReturnType<typeof setTimeout>;
  error: string | null;
}

// 4.1.8 Provider Definition
export type ProviderKind = "codex_app_server" | "claude_agent_sdk";

export interface ProviderDefinition {
  name: string;
  kind: ProviderKind;
}

// Running Entry (orchestrator tracking per-issue)
export interface RunningEntry {
  workerHandle: AbortController;
  identifier: string;
  issue: Issue;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  agentProcessPid: string | null;
  lastAgentMessage: string | null;
  lastAgentEvent: string | null;
  lastAgentTimestamp: Date | null;
  agentInputTokens: number;
  agentOutputTokens: number;
  agentTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  retryAttempt: number | null;
  startedAt: Date;
  turnCount: number;
}

// 4.1.10 Orchestrator Runtime State
export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  agentTotals: AgentTotals;
  agentRateLimits: Record<string, unknown> | null;
}

export interface AgentTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

// Agent Events (Section 10.4)
export type AgentEventType =
  | "session_started"
  | "startup_failed"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_ended_with_error"
  | "turn_input_required"
  | "approval_auto_approved"
  | "unsupported_tool_call"
  | "notification"
  | "other_message"
  | "malformed";

export interface AgentEvent {
  event: AgentEventType;
  timestamp: Date;
  agentProcessPid?: string;
  usage?: TokenUsage;
  payload?: Record<string, unknown>;
  message?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// Provider interface
export interface AgentProvider {
  name: string;
  kind: ProviderKind;

  startSession(params: SessionParams): Promise<AgentSession>;
}

export interface SessionParams {
  workspacePath: string;
  prompt: string;
  issue: Issue;
  attempt: number | null;
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
}

export interface AgentSession {
  runTurn(prompt: string): Promise<TurnResult>;
  stop(): Promise<void>;
  threadId: string | null;
}

export type TurnResult =
  | { status: "completed" }
  | { status: "failed"; error: string }
  | { status: "cancelled" }
  | { status: "input_required" };
