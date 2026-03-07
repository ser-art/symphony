// Symphony TypeScript - Optional HTTP Server (Section 13.7)
// Observability dashboard and JSON API

import type { Orchestrator } from "./orchestrator";
import { logger } from "./logger";

export class HttpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private orchestrator: Orchestrator;
  private port: number;

  constructor(orchestrator: Orchestrator, port: number) {
    this.orchestrator = orchestrator;
    this.port = port;
  }

  start(): void {
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      fetch: (req) => this.handleRequest(req),
    });

    logger.info("HTTP server started", {
      port: String(this.server.port),
      url: `http://127.0.0.1:${this.server.port}`,
    });
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }

  getPort(): number {
    return this.server?.port ?? this.port;
  }

  private handleRequest(req: Request): Response {
    const url = new URL(req.url);
    const path = url.pathname;

    // Dashboard
    if (path === "/" && req.method === "GET") {
      return this.handleDashboard();
    }

    // JSON API
    if (path === "/api/v1/state" && req.method === "GET") {
      return this.handleState();
    }

    if (path === "/api/v1/refresh" && req.method === "POST") {
      return this.handleRefresh();
    }

    // Issue detail: /api/v1/<identifier>
    if (path.startsWith("/api/v1/") && req.method === "GET") {
      const identifier = path.slice("/api/v1/".length);
      if (identifier && identifier !== "state") {
        return this.handleIssueDetail(identifier);
      }
    }

    // Method not allowed for known routes
    if (path === "/api/v1/state" || path === "/api/v1/refresh" || path === "/") {
      return jsonResponse(
        { error: { code: "method_not_allowed", message: "Method not allowed" } },
        405,
      );
    }

    return jsonResponse(
      { error: { code: "not_found", message: "Not found" } },
      404,
    );
  }

  private handleDashboard(): Response {
    const snapshot = this.orchestrator.getSnapshot() as any;

    const runningRows = (snapshot.running || [])
      .map(
        (r: any) => `
      <tr>
        <td>${esc(r.issue_identifier)}</td>
        <td>${esc(r.state)}</td>
        <td>${r.turn_count}</td>
        <td>${esc(r.last_event ?? "")}</td>
        <td>${esc(r.last_message ?? "")}</td>
        <td>${r.tokens?.total_tokens ?? 0}</td>
        <td>${esc(r.started_at ?? "")}</td>
      </tr>`,
      )
      .join("");

    const retryRows = (snapshot.retrying || [])
      .map(
        (r: any) => `
      <tr>
        <td>${esc(r.issue_identifier)}</td>
        <td>${r.attempt}</td>
        <td>${esc(r.due_at ?? "")}</td>
        <td>${esc(r.error ?? "")}</td>
      </tr>`,
      )
      .join("");

    const totals = snapshot.agent_totals || {};

    const html = `<!DOCTYPE html>
<html><head><title>Symphony Dashboard</title>
<meta http-equiv="refresh" content="5">
<style>
  body { font-family: monospace; margin: 2rem; background: #1a1a2e; color: #e0e0e0; }
  h1 { color: #7b68ee; }
  h2 { color: #9370db; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { border: 1px solid #333; padding: 0.4rem 0.8rem; text-align: left; }
  th { background: #252545; }
  .totals { display: flex; gap: 2rem; margin-top: 1rem; }
  .metric { background: #252545; padding: 1rem; border-radius: 4px; }
  .metric-label { font-size: 0.8rem; color: #888; }
  .metric-value { font-size: 1.4rem; font-weight: bold; color: #7b68ee; }
</style></head><body>
<h1>Symphony</h1>
<p>Generated: ${esc(snapshot.generated_at)}</p>

<div class="totals">
  <div class="metric"><div class="metric-label">Running</div><div class="metric-value">${snapshot.counts?.running ?? 0}</div></div>
  <div class="metric"><div class="metric-label">Retrying</div><div class="metric-value">${snapshot.counts?.retrying ?? 0}</div></div>
  <div class="metric"><div class="metric-label">Total Tokens</div><div class="metric-value">${totals.total_tokens ?? 0}</div></div>
  <div class="metric"><div class="metric-label">Runtime (s)</div><div class="metric-value">${totals.seconds_running ?? 0}</div></div>
</div>

<h2>Running Sessions</h2>
<table>
  <tr><th>Issue</th><th>State</th><th>Turns</th><th>Last Event</th><th>Message</th><th>Tokens</th><th>Started</th></tr>
  ${runningRows || "<tr><td colspan=7>No running sessions</td></tr>"}
</table>

<h2>Retry Queue</h2>
<table>
  <tr><th>Issue</th><th>Attempt</th><th>Due At</th><th>Error</th></tr>
  ${retryRows || "<tr><td colspan=4>No retries queued</td></tr>"}
</table>
</body></html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  private handleState(): Response {
    return jsonResponse(this.orchestrator.getSnapshot());
  }

  private handleRefresh(): Response {
    this.orchestrator.triggerRefresh();
    return jsonResponse(
      {
        queued: true,
        coalesced: false,
        requested_at: new Date().toISOString(),
        operations: ["poll", "reconcile"],
      },
      202,
    );
  }

  private handleIssueDetail(identifier: string): Response {
    const snapshot = this.orchestrator.getSnapshot() as any;

    // Find in running
    const running = (snapshot.running || []).find(
      (r: any) => r.issue_identifier === identifier,
    );

    // Find in retrying
    const retrying = (snapshot.retrying || []).find(
      (r: any) => r.issue_identifier === identifier,
    );

    if (!running && !retrying) {
      return jsonResponse(
        {
          error: {
            code: "issue_not_found",
            message: `Issue ${identifier} not found in current state`,
          },
        },
        404,
      );
    }

    return jsonResponse({
      issue_identifier: identifier,
      issue_id: running?.issue_id ?? retrying?.issue_id,
      status: running ? "running" : "retrying",
      running: running ?? null,
      retry: retrying ?? null,
    });
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
