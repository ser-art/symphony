// Symphony TypeScript - CLI Entry Point (Section 17.7)
// Starts the orchestrator service

import { resolve } from "path";
import { loadWorkflow, WorkflowError } from "./workflow";
import { buildConfig, validateDispatchConfig } from "./config";
import { Orchestrator } from "./orchestrator";
import { WorkflowWatcher } from "./watcher";
import { HttpServer } from "./server";
import { logger, setLogLevel } from "./logger";

function loadEnvFile(filePath: string): void {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return;
  const content = fs.readFileSync(resolved, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseArgs(): { workflowPath: string; port: number | null; logsRoot: string | null } {
  const args = process.argv.slice(2);
  let workflowPath = resolve("WORKFLOW.md");
  let port: number | null = null;
  let logsRoot: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--port" && i + 1 < args.length) {
      port = parseInt(args[++i]!, 10);
    } else if (arg === "--logs-root" && i + 1 < args.length) {
      logsRoot = args[++i] ?? null;
    } else if (arg === "--debug") {
      setLogLevel("debug");
    } else if (arg === "--env" && i + 1 < args.length) {
      loadEnvFile(args[++i]!);
    } else if (!arg.startsWith("-")) {
      workflowPath = resolve(arg);
    }
  }

  return { workflowPath, port, logsRoot };
}

async function main(): Promise<void> {
  loadEnvFile(".env");

  const { workflowPath, port: cliPort, logsRoot } = parseArgs();

  logger.info("Symphony TypeScript starting", { workflow: workflowPath });

  // Load workflow
  let workflow;
  try {
    workflow = await loadWorkflow(workflowPath);
  } catch (e) {
    if (e instanceof WorkflowError) {
      logger.error(`Startup failed: ${e.code}: ${e.message}`);
    } else {
      logger.error(`Startup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  }

  let config = buildConfig(workflow);

  // CLI --port overrides server.port
  const serverPort = cliPort ?? config.serverPort;

  // Validate
  const validation = validateDispatchConfig(config);
  if (!validation.ok) {
    logger.error(`Startup validation failed: ${validation.errors.join("; ")}`);
    process.exit(1);
  }

  // Create orchestrator
  const orchestrator = new Orchestrator(config, workflow.promptTemplate);

  // Setup workflow watcher for dynamic reload
  const watcher = new WorkflowWatcher(workflowPath, async () => {
    try {
      const reloaded = await loadWorkflow(workflowPath);
      const newConfig = buildConfig(reloaded);
      const v = validateDispatchConfig(newConfig);
      if (!v.ok) {
        logger.error("Invalid workflow reload, keeping current config", {
          errors: v.errors.join("; "),
        });
        return;
      }
      config = newConfig;
      orchestrator.reloadConfig(newConfig, reloaded.promptTemplate);
    } catch (e) {
      logger.error("Workflow reload failed, keeping current config", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  watcher.start();

  // Start HTTP server if configured
  let httpServer: HttpServer | null = null;
  if (serverPort !== null && serverPort !== undefined) {
    httpServer = new HttpServer(orchestrator, serverPort);
    httpServer.start();
  }

  // Start orchestrator
  await orchestrator.start();

  logger.info("Symphony is running", {
    pollInterval: String(config.polling.intervalMs),
    maxAgents: String(config.agent.maxConcurrentAgents),
    provider: config.agent.defaultProvider,
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down...");
    orchestrator.stop();
    watcher.stop();
    httpServer?.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  logger.error(`Fatal error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
