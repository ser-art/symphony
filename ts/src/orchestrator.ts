// Symphony TypeScript - Orchestrator (Sections 7, 8, 16)
// Core poll loop, dispatch, reconciliation, retry

import type {
  Issue,
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  AgentEvent,
  AgentTotals,
} from "./types";
import type { ServiceConfig } from "./config";
import { validateDispatchConfig, type ValidationResult } from "./config";
import { LinearClient } from "./linear/client";
import {
  ensureWorkspace,
  runBeforeRunHook,
  runAfterRunHook,
  cleanupWorkspace,
} from "./workspace/manager";
import { renderPrompt } from "./prompt";
import { ProviderRegistry } from "./providers/registry";
import { logger } from "./logger";

export class Orchestrator {
  private state: OrchestratorState;
  private config: ServiceConfig;
  private promptTemplate: string;
  private linearClient: LinearClient;
  private providerRegistry: ProviderRegistry;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(config: ServiceConfig, promptTemplate: string) {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.linearClient = new LinearClient(config.tracker);
    this.providerRegistry = new ProviderRegistry(config);

    this.state = {
      pollIntervalMs: config.polling.intervalMs,
      maxConcurrentAgents: config.agent.maxConcurrentAgents,
      running: new Map(),
      claimed: new Set(),
      retryAttempts: new Map(),
      completed: new Set(),
      agentTotals: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        secondsRunning: 0,
      },
      agentRateLimits: null,
    };
  }

  // Section 6.2 - Dynamic reload
  reloadConfig(config: ServiceConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.state.pollIntervalMs = config.polling.intervalMs;
    this.state.maxConcurrentAgents = config.agent.maxConcurrentAgents;
    this.linearClient = new LinearClient(config.tracker);
    this.providerRegistry.update(config);
    logger.info("Configuration reloaded");
  }

  // Section 16.1 - Service startup
  async start(): Promise<void> {
    const validation = validateDispatchConfig(this.config);
    if (!validation.ok) {
      logger.error("Startup validation failed", {
        errors: validation.errors.join("; "),
      });
      throw new Error(
        `Startup validation failed: ${validation.errors.join("; ")}`,
      );
    }

    await this.startupTerminalCleanup();
    this.scheduleTick(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    // Stop all running workers
    for (const [issueId, entry] of this.state.running) {
      logger.info("Stopping running worker on shutdown", {
        issueIdentifier: entry.identifier,
      });
      entry.workerHandle.abort();
    }

    // Cancel all retry timers
    for (const [, entry] of this.state.retryAttempts) {
      clearTimeout(entry.timerHandle);
    }
    this.state.retryAttempts.clear();
  }

  // Runtime snapshot for observability (Section 13.3)
  getSnapshot(): Record<string, unknown> {
    const running = Array.from(this.state.running.entries()).map(
      ([id, entry]) => ({
        issue_id: id,
        issue_identifier: entry.identifier,
        state: entry.issue.state,
        session_id: entry.sessionId,
        turn_count: entry.turnCount,
        last_event: entry.lastAgentEvent,
        last_message: entry.lastAgentMessage ?? "",
        started_at: entry.startedAt.toISOString(),
        last_event_at: entry.lastAgentTimestamp?.toISOString() ?? null,
        tokens: {
          input_tokens: entry.agentInputTokens,
          output_tokens: entry.agentOutputTokens,
          total_tokens: entry.agentTotalTokens,
        },
      }),
    );

    const retrying = Array.from(this.state.retryAttempts.entries()).map(
      ([id, entry]) => ({
        issue_id: id,
        issue_identifier: entry.identifier,
        attempt: entry.attempt,
        due_at: new Date(entry.dueAtMs).toISOString(),
        error: entry.error,
      }),
    );

    // Live aggregate: add active session time
    const liveSeconds = Array.from(this.state.running.values()).reduce(
      (acc, entry) => {
        return acc + (Date.now() - entry.startedAt.getTime()) / 1000;
      },
      0,
    );

    return {
      generated_at: new Date().toISOString(),
      counts: {
        running: running.length,
        retrying: retrying.length,
      },
      running,
      retrying,
      agent_totals: {
        input_tokens: this.state.agentTotals.inputTokens,
        output_tokens: this.state.agentTotals.outputTokens,
        total_tokens: this.state.agentTotals.totalTokens,
        seconds_running:
          Math.round(
            (this.state.agentTotals.secondsRunning + liveSeconds) * 10,
          ) / 10,
      },
      rate_limits: this.state.agentRateLimits,
    };
  }

  // Trigger immediate poll (for /api/v1/refresh)
  triggerRefresh(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.scheduleTick(0);
  }

  // Section 16.2 - Poll tick
  private async onTick(): Promise<void> {
    if (this.stopped) return;

    try {
      // Reconcile first
      await this.reconcileRunningIssues();

      // Validate config
      const validation = validateDispatchConfig(this.config);
      if (!validation.ok) {
        logger.error("Dispatch validation failed, skipping dispatch", {
          errors: validation.errors.join("; "),
        });
        this.scheduleTick(this.state.pollIntervalMs);
        return;
      }

      // Fetch candidates
      let issues: Issue[];
      try {
        issues = await this.linearClient.fetchCandidateIssues(
          this.config.tracker.activeStates,
        );
      } catch (e) {
        logger.error("Candidate fetch failed, skipping dispatch", {
          error: e instanceof Error ? e.message : String(e),
        });
        this.scheduleTick(this.state.pollIntervalMs);
        return;
      }

      // Sort and dispatch
      const sorted = this.sortForDispatch(issues);
      for (const issue of sorted) {
        if (this.noAvailableSlots()) break;
        if (this.shouldDispatch(issue)) {
          this.dispatchIssue(issue, null);
        }
      }
    } catch (e) {
      logger.error("Tick error", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    this.scheduleTick(this.state.pollIntervalMs);
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.tickTimer = setTimeout(() => this.onTick(), delayMs);
  }

  // Section 8.2 - Candidate selection
  private shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state)
      return false;

    const normalizedState = issue.state.trim().toLowerCase();

    // Must be in active states
    const isActive = this.config.tracker.activeStates.some(
      (s) => s.trim().toLowerCase() === normalizedState,
    );
    if (!isActive) return false;

    // Must not be in terminal states
    const isTerminal = this.config.tracker.terminalStates.some(
      (s) => s.trim().toLowerCase() === normalizedState,
    );
    if (isTerminal) return false;

    // Not already running or claimed
    if (this.state.running.has(issue.id)) return false;
    if (this.state.claimed.has(issue.id)) return false;

    // Global concurrency
    if (this.noAvailableSlots()) return false;

    // Per-state concurrency
    if (!this.stateSlotAvailable(normalizedState)) return false;

    // Trigger labels filter
    if (this.config.tracker.triggerLabels.length > 0) {
      const issueLabels = issue.labels.map((l) => l.trim().toLowerCase());
      const hasMatch = this.config.tracker.triggerLabels.some((tl) =>
        issueLabels.includes(tl),
      );
      if (!hasMatch) return false;
    }

    // Blocker rule for Todo state
    if (normalizedState === "todo") {
      const hasNonTerminalBlocker = issue.blockedBy.some((b) => {
        if (!b.state) return true; // unknown state = non-terminal
        return !this.config.tracker.terminalStates.some(
          (ts) => ts.trim().toLowerCase() === b.state!.trim().toLowerCase(),
        );
      });
      if (hasNonTerminalBlocker) return false;
    }

    return true;
  }

  // Section 8.2 - Dispatch sort
  private sortForDispatch(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      // Priority ascending (null sorts last)
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;

      // Created at oldest first
      const ca = a.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const cb = b.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (ca !== cb) return ca - cb;

      // Identifier tie-breaker
      return a.identifier.localeCompare(b.identifier);
    });
  }

  private noAvailableSlots(): boolean {
    return this.state.running.size >= this.state.maxConcurrentAgents;
  }

  private stateSlotAvailable(normalizedState: string): boolean {
    const limit = this.config.agent.maxConcurrentAgentsByState.get(
      normalizedState,
    );
    if (limit === undefined) return true; // No per-state limit

    const count = Array.from(this.state.running.values()).filter(
      (e) => e.issue.state.trim().toLowerCase() === normalizedState,
    ).length;

    return count < limit;
  }

  // Section 16.4 - Dispatch one issue
  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const abortController = new AbortController();

    const entry: RunningEntry = {
      workerHandle: abortController,
      identifier: issue.identifier,
      issue,
      sessionId: null,
      threadId: null,
      turnId: null,
      agentProcessPid: null,
      lastAgentMessage: null,
      lastAgentEvent: null,
      lastAgentTimestamp: null,
      agentInputTokens: 0,
      agentOutputTokens: 0,
      agentTotalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      retryAttempt: attempt,
      startedAt: new Date(),
      turnCount: 0,
    };

    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);

    // Cancel any existing retry
    const existingRetry = this.state.retryAttempts.get(issue.id);
    if (existingRetry) {
      clearTimeout(existingRetry.timerHandle);
      this.state.retryAttempts.delete(issue.id);
    }

    logger.info("Dispatching issue", {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      state: issue.state,
      attempt: String(attempt ?? "initial"),
    });

    // Run worker async
    this.runWorker(issue, attempt, abortController.signal).then(
      () => this.onWorkerExit(issue.id, "normal"),
      (e) =>
        this.onWorkerExit(
          issue.id,
          e instanceof Error ? e.message : String(e),
        ),
    );
  }

  // Section 16.5 - Worker attempt
  private async runWorker(
    issue: Issue,
    attempt: number | null,
    signal: AbortSignal,
  ): Promise<void> {
    const identifier = issue.identifier;

    // Create/reuse workspace
    const workspace = await ensureWorkspace(
      identifier,
      this.config.workspace,
      this.config.hooks,
      identifier,
    );

    // Run before_run hook
    await runBeforeRunHook(
      workspace.path,
      this.config.hooks,
      identifier,
      this.config.workspace.defaultBranch,
      this.config.agent.language,
    );

    // Get provider for this issue
    const provider = this.providerRegistry.resolveProvider(
      issue,
      this.config.routing.rules,
      this.config.agent.defaultProvider,
    );

    // Start session
    let session;
    try {
      session = await provider.startSession({
        workspacePath: workspace.path,
        prompt: "",
        issue,
        attempt,
        onEvent: (event) => this.onAgentEvent(issue.id, event),
        signal,
      });
    } catch (e) {
      await runAfterRunHook(
        workspace.path,
        this.config.hooks,
        identifier,
        this.config.workspace.defaultBranch,
        this.config.agent.language,
      );
      throw e;
    }

    const maxTurns = this.config.agent.maxTurns;
    let turnNumber = 1;
    let currentIssue = issue;

    try {
      while (!signal.aborted) {
        // Build prompt
        const prompt = await renderPrompt(this.promptTemplate, {
          issue: currentIssue,
          attempt: turnNumber === 1 ? attempt : (attempt ?? 0) + turnNumber - 1,
          defaultBranch: this.config.workspace.defaultBranch,
          language: this.config.agent.language,
        });

        // Update turn count
        const entry = this.state.running.get(issue.id);
        if (entry) {
          entry.turnCount = turnNumber;
          entry.threadId = session.threadId;
        }

        // Run turn
        const result = await session.runTurn(prompt);

        if (result.status !== "completed") {
          throw new Error(
            `Agent turn ${result.status}: ${"error" in result ? result.error : ""}`,
          );
        }

        // Check if issue is still active
        try {
          const refreshed = await this.linearClient.fetchIssueStatesByIds([
            issue.id,
          ]);
          if (refreshed.length > 0 && refreshed[0]) {
            currentIssue = refreshed[0];
            const entry = this.state.running.get(issue.id);
            if (entry) entry.issue = currentIssue;
          }
        } catch (e) {
          logger.warn("Issue state refresh failed after turn", {
            issueIdentifier: identifier,
            error: e instanceof Error ? e.message : String(e),
          });
          break;
        }

        const isActive = this.config.tracker.activeStates.some(
          (s) =>
            s.trim().toLowerCase() ===
            currentIssue.state.trim().toLowerCase(),
        );
        if (!isActive) break;

        if (turnNumber >= maxTurns) {
          logger.info("Max turns reached", {
            issueIdentifier: identifier,
            turns: String(turnNumber),
          });
          break;
        }

        turnNumber++;
      }
    } finally {
      await session.stop();
      await runAfterRunHook(
        workspace.path,
        this.config.hooks,
        identifier,
        this.config.workspace.defaultBranch,
        this.config.agent.language,
      );
    }
  }

  // Section 10.4 - Agent event handler
  private onAgentEvent(issueId: string, event: AgentEvent): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    entry.lastAgentEvent = event.event;
    entry.lastAgentTimestamp = event.timestamp;
    if (event.message) entry.lastAgentMessage = event.message;
    if (event.agentProcessPid) entry.agentProcessPid = event.agentProcessPid;

    if (event.payload?.sessionId) {
      entry.sessionId = event.payload.sessionId as string;
    }
    if (event.payload?.threadId) {
      entry.threadId = event.payload.threadId as string;
    }
    if (event.payload?.turnId) {
      entry.turnId = event.payload.turnId as string;
    }

    // Token accounting (Section 13.5)
    if (event.usage) {
      const deltaInput =
        event.usage.inputTokens - entry.lastReportedInputTokens;
      const deltaOutput =
        event.usage.outputTokens - entry.lastReportedOutputTokens;
      const deltaTotal =
        event.usage.totalTokens - entry.lastReportedTotalTokens;

      if (deltaInput > 0 || deltaOutput > 0 || deltaTotal > 0) {
        entry.agentInputTokens += Math.max(deltaInput, 0);
        entry.agentOutputTokens += Math.max(deltaOutput, 0);
        entry.agentTotalTokens += Math.max(deltaTotal, 0);

        this.state.agentTotals.inputTokens += Math.max(deltaInput, 0);
        this.state.agentTotals.outputTokens += Math.max(deltaOutput, 0);
        this.state.agentTotals.totalTokens += Math.max(deltaTotal, 0);

        entry.lastReportedInputTokens = event.usage.inputTokens;
        entry.lastReportedOutputTokens = event.usage.outputTokens;
        entry.lastReportedTotalTokens = event.usage.totalTokens;
      }
    }

    // Rate limit tracking
    if (event.payload?.rateLimits) {
      this.state.agentRateLimits = event.payload
        .rateLimits as Record<string, unknown>;
    }
  }

  // Section 16.6 - Worker exit
  private onWorkerExit(issueId: string, reason: string): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    // Add runtime seconds
    const elapsed = (Date.now() - entry.startedAt.getTime()) / 1000;
    this.state.agentTotals.secondsRunning += elapsed;

    this.state.running.delete(issueId);

    if (reason === "normal") {
      this.state.completed.add(issueId);
      // Schedule short continuation retry
      this.scheduleRetry(issueId, 1, {
        identifier: entry.identifier,
        error: null,
        delayMs: 1000, // continuation delay
      });
      logger.info("Worker completed normally, scheduling continuation", {
        issueIdentifier: entry.identifier,
      });
    } else {
      const nextAttempt = (entry.retryAttempt ?? 0) + 1;
      this.scheduleRetry(issueId, nextAttempt, {
        identifier: entry.identifier,
        error: reason,
      });
      logger.warn("Worker failed, scheduling retry", {
        issueIdentifier: entry.identifier,
        error: reason,
        attempt: String(nextAttempt),
      });
    }
  }

  // Section 8.4 - Retry scheduling
  private scheduleRetry(
    issueId: string,
    attempt: number,
    opts: { identifier: string; error: string | null; delayMs?: number },
  ): void {
    // Cancel existing retry
    const existing = this.state.retryAttempts.get(issueId);
    if (existing) {
      clearTimeout(existing.timerHandle);
    }

    // Calculate delay
    const delayMs =
      opts.delayMs ??
      Math.min(
        10000 * Math.pow(2, attempt - 1),
        this.config.agent.maxRetryBackoffMs,
      );

    const dueAtMs = Date.now() + delayMs;

    const timerHandle = setTimeout(() => {
      this.onRetryTimer(issueId);
    }, delayMs);

    this.state.retryAttempts.set(issueId, {
      issueId,
      identifier: opts.identifier,
      attempt,
      dueAtMs,
      timerHandle,
      error: opts.error,
    });
  }

  // Section 16.6 - Retry timer
  private async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.state.retryAttempts.get(issueId);
    if (!retryEntry) return;
    this.state.retryAttempts.delete(issueId);

    let candidates: Issue[];
    try {
      candidates = await this.linearClient.fetchCandidateIssues(
        this.config.tracker.activeStates,
      );
    } catch (e) {
      this.scheduleRetry(issueId, retryEntry.attempt + 1, {
        identifier: retryEntry.identifier,
        error: "retry poll failed",
      });
      return;
    }

    const issue = candidates.find((i) => i.id === issueId);
    if (!issue) {
      // Issue no longer active
      this.state.claimed.delete(issueId);
      logger.info("Issue no longer active, releasing claim", {
        issueIdentifier: retryEntry.identifier,
      });
      return;
    }

    if (this.noAvailableSlots()) {
      this.scheduleRetry(issueId, retryEntry.attempt + 1, {
        identifier: issue.identifier,
        error: "no available orchestrator slots",
      });
      return;
    }

    this.dispatchIssue(issue, retryEntry.attempt);
  }

  // Section 16.3 / 8.5 - Reconciliation
  private async reconcileRunningIssues(): Promise<void> {
    // Part A: Stall detection
    await this.reconcileStalledRuns();

    const runningIds = Array.from(this.state.running.keys());
    if (runningIds.length === 0) return;

    // Part B: Tracker state refresh
    let refreshed: Issue[];
    try {
      refreshed = await this.linearClient.fetchIssueStatesByIds(runningIds);
    } catch (e) {
      logger.debug("Reconciliation state refresh failed, keeping workers", {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const refreshedMap = new Map(refreshed.map((i) => [i.id, i]));

    for (const issueId of runningIds) {
      const issue = refreshedMap.get(issueId);
      if (!issue) continue;

      const normalizedState = issue.state.trim().toLowerCase();

      const isTerminal = this.config.tracker.terminalStates.some(
        (s) => s.trim().toLowerCase() === normalizedState,
      );

      if (isTerminal) {
        await this.terminateRunningIssue(issueId, true);
        continue;
      }

      const isActive = this.config.tracker.activeStates.some(
        (s) => s.trim().toLowerCase() === normalizedState,
      );

      if (isActive) {
        const entry = this.state.running.get(issueId);
        if (entry) entry.issue = issue;
      } else {
        // Not active and not terminal
        await this.terminateRunningIssue(issueId, false);
      }
    }
  }

  private async reconcileStalledRuns(): Promise<void> {
    const now = Date.now();

    for (const [issueId, entry] of this.state.running) {
      // Get stall timeout from the provider config
      const provider = this.providerRegistry.resolveProvider(
        entry.issue,
        this.config.routing.rules,
        this.config.agent.defaultProvider,
      );
      const stallTimeoutMs =
        provider.kind === "codex_app_server"
          ? this.config.codex.stallTimeoutMs
          : this.config.claude.stallTimeoutMs;

      if (stallTimeoutMs <= 0) continue;

      const reference = entry.lastAgentTimestamp ?? entry.startedAt;
      const elapsedMs = now - reference.getTime();

      if (elapsedMs > stallTimeoutMs) {
        logger.warn("Stalled session detected, terminating", {
          issueIdentifier: entry.identifier,
          elapsedMs: String(elapsedMs),
        });
        entry.workerHandle.abort();
        // Worker exit handler will schedule retry
      }
    }
  }

  private async terminateRunningIssue(
    issueId: string,
    cleanupWorkspaceDir: boolean,
  ): Promise<void> {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    logger.info("Terminating running issue", {
      issueIdentifier: entry.identifier,
      cleanup: String(cleanupWorkspaceDir),
    });

    entry.workerHandle.abort();

    // Add runtime
    const elapsed = (Date.now() - entry.startedAt.getTime()) / 1000;
    this.state.agentTotals.secondsRunning += elapsed;

    this.state.running.delete(issueId);
    this.state.claimed.delete(issueId);

    if (cleanupWorkspaceDir) {
      try {
        await cleanupWorkspace(
          entry.identifier,
          this.config.workspace,
          this.config.hooks,
          this.config.agent.language,
        );
      } catch (e) {
        logger.warn("Workspace cleanup failed", {
          issueIdentifier: entry.identifier,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // Section 8.6 - Startup terminal cleanup
  private async startupTerminalCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.linearClient.fetchIssuesByStates(
        this.config.tracker.terminalStates,
      );

      for (const issue of terminalIssues) {
        try {
          await cleanupWorkspace(
            issue.identifier,
            this.config.workspace,
            this.config.hooks,
            this.config.agent.language,
          );
        } catch (e) {
          logger.debug("Terminal workspace cleanup failed", {
            issueIdentifier: issue.identifier,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (terminalIssues.length > 0) {
        logger.info("Startup terminal cleanup complete", {
          count: String(terminalIssues.length),
        });
      }
    } catch (e) {
      logger.warn("Startup terminal cleanup fetch failed, continuing", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
