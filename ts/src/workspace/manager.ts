// Symphony TypeScript - Workspace Manager (Section 9)
// Per-issue workspace creation, reuse, hooks, and safety

import { mkdir, rm, stat, readdir } from "fs/promises";
import { resolve, normalize } from "path";
import { spawn } from "child_process";
import { logger } from "../logger";
import type { HooksConfig, WorkspaceConfig } from "../config";

export interface WorkspaceResult {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

// Section 4.2 - Sanitize identifier: only [A-Za-z0-9._-]
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

// Section 9.5 - Safety: workspace path must be under root
function validateWorkspacePath(
  workspacePath: string,
  workspaceRoot: string,
): void {
  const normalizedPath = normalize(resolve(workspacePath));
  const normalizedRoot = normalize(resolve(workspaceRoot));

  if (!normalizedPath.startsWith(normalizedRoot + "/")) {
    throw new Error(
      `Workspace path ${normalizedPath} is outside workspace root ${normalizedRoot}`,
    );
  }
}

export async function ensureWorkspace(
  identifier: string,
  config: WorkspaceConfig,
  hooks: HooksConfig,
  issueIdentifier: string,
): Promise<WorkspaceResult> {
  const key = sanitizeWorkspaceKey(identifier);
  const wsPath = resolve(config.root, key);

  validateWorkspacePath(wsPath, config.root);

  let createdNow = false;
  try {
    const s = await stat(wsPath);
    if (!s.isDirectory()) {
      // Non-directory at workspace location - remove and recreate
      await rm(wsPath, { force: true });
      await mkdir(wsPath, { recursive: true });
      createdNow = true;
    }
  } catch {
    // Doesn't exist - create it
    await mkdir(wsPath, { recursive: true });
    createdNow = true;
  }

  if (createdNow && hooks.afterCreate) {
    logger.info("Running after_create hook", { issueIdentifier });
    try {
      await runHook(
        hooks.afterCreate,
        wsPath,
        hooks.timeoutMs,
        issueIdentifier,
        config.defaultBranch,
      );
    } catch (e) {
      // Fatal to workspace creation - clean up partial workspace
      logger.error("after_create hook failed, removing workspace", {
        issueIdentifier,
        error: e instanceof Error ? e.message : String(e),
      });
      await rm(wsPath, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  return { path: wsPath, workspaceKey: key, createdNow };
}

export async function runBeforeRunHook(
  wsPath: string,
  hooks: HooksConfig,
  issueIdentifier: string,
  defaultBranch: string,
  language: string,
): Promise<void> {
  if (!hooks.beforeRun) return;
  logger.info("Running before_run hook", { issueIdentifier });
  await runHook(
    hooks.beforeRun,
    wsPath,
    hooks.timeoutMs,
    issueIdentifier,
    defaultBranch,
    language,
  );
}

export async function runAfterRunHook(
  wsPath: string,
  hooks: HooksConfig,
  issueIdentifier: string,
  defaultBranch: string,
  language: string,
): Promise<void> {
  if (!hooks.afterRun) return;
  logger.info("Running after_run hook", { issueIdentifier });
  try {
    await runHook(
      hooks.afterRun,
      wsPath,
      hooks.timeoutMs,
      issueIdentifier,
      defaultBranch,
      language,
    );
  } catch (e) {
    logger.warn("after_run hook failed (ignored)", {
      issueIdentifier,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function runBeforeRemoveHook(
  wsPath: string,
  hooks: HooksConfig,
  issueIdentifier: string,
  defaultBranch: string,
  language: string,
): Promise<void> {
  if (!hooks.beforeRemove) return;
  logger.info("Running before_remove hook", { issueIdentifier });
  try {
    await runHook(
      hooks.beforeRemove,
      wsPath,
      hooks.timeoutMs,
      issueIdentifier,
      defaultBranch,
      language,
    );
  } catch (e) {
    logger.warn("before_remove hook failed (ignored)", {
      issueIdentifier,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function cleanupWorkspace(
  identifier: string,
  config: WorkspaceConfig,
  hooks: HooksConfig,
  language: string,
): Promise<void> {
  const key = sanitizeWorkspaceKey(identifier);
  const wsPath = resolve(config.root, key);

  try {
    await stat(wsPath);
  } catch {
    return; // doesn't exist, nothing to clean
  }

  await runBeforeRemoveHook(
    wsPath,
    hooks,
    identifier,
    config.defaultBranch,
    language,
  );

  logger.info("Removing workspace", {
    issueIdentifier: identifier,
    path: wsPath,
  });
  await rm(wsPath, { recursive: true, force: true });
}

function runHook(
  script: string,
  cwd: string,
  timeoutMs: number,
  issueIdentifier: string,
  defaultBranch: string,
  language: string = "ru",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-lc", script], {
      cwd,
      env: {
        ...process.env,
        SYMPHONY_WORKSPACE_PATH: cwd,
        SYMPHONY_ISSUE_IDENTIFIER: issueIdentifier,
        SYMPHONY_DEFAULT_BRANCH: defaultBranch,
        SYMPHONY_LANGUAGE: language,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
      // Truncate in logs
      if (stdout.length > 4096) stdout = stdout.slice(-4096);
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const errMsg = stderr.trim() || `Hook exited with code ${code}`;
        reject(new Error(errMsg));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
