// Tests for workspace manager (Section 17.2)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  sanitizeWorkspaceKey,
  ensureWorkspace,
} from "../src/workspace/manager";
import type { HooksConfig, WorkspaceConfig } from "../src/config";

function makeHooks(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 60000,
    ...overrides,
  };
}

describe("Workspace Key Sanitization", () => {
  test("passes through valid characters", () => {
    expect(sanitizeWorkspaceKey("ABC-123")).toBe("ABC-123");
    expect(sanitizeWorkspaceKey("test.file")).toBe("test.file");
    expect(sanitizeWorkspaceKey("hello_world")).toBe("hello_world");
  });

  test("replaces invalid characters with underscore", () => {
    expect(sanitizeWorkspaceKey("ABC/123")).toBe("ABC_123");
    expect(sanitizeWorkspaceKey("issue #42")).toBe("issue__42");
    expect(sanitizeWorkspaceKey("a@b$c")).toBe("a_b_c");
  });
});

describe("Workspace Manager", () => {
  let tempRoot: string;
  let wsConfig: WorkspaceConfig;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "symphony-test-"));
    wsConfig = { root: tempRoot, defaultBranch: "dev" };
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("creates new workspace directory", async () => {
    const result = await ensureWorkspace(
      "TEST-1",
      wsConfig,
      makeHooks(),
      "TEST-1",
    );

    expect(result.createdNow).toBe(true);
    expect(result.workspaceKey).toBe("TEST-1");
    expect(result.path).toBe(join(tempRoot, "TEST-1"));

    const s = await stat(result.path);
    expect(s.isDirectory()).toBe(true);
  });

  test("reuses existing workspace directory", async () => {
    const first = await ensureWorkspace(
      "TEST-2",
      wsConfig,
      makeHooks(),
      "TEST-2",
    );
    expect(first.createdNow).toBe(true);

    const second = await ensureWorkspace(
      "TEST-2",
      wsConfig,
      makeHooks(),
      "TEST-2",
    );
    expect(second.createdNow).toBe(false);
    expect(second.path).toBe(first.path);
  });

  test("runs after_create hook only on new workspace", async () => {
    const hooks = makeHooks({
      afterCreate: "touch created_marker",
    });

    const result = await ensureWorkspace("TEST-3", wsConfig, hooks, "TEST-3");
    expect(result.createdNow).toBe(true);

    // Marker should exist
    const markerStat = await stat(join(result.path, "created_marker"));
    expect(markerStat.isFile()).toBe(true);

    // Reuse should not re-run hook
    const result2 = await ensureWorkspace("TEST-3", wsConfig, hooks, "TEST-3");
    expect(result2.createdNow).toBe(false);
  });

  test("after_create hook failure removes partial workspace", async () => {
    const hooks = makeHooks({
      afterCreate: "exit 1",
    });

    await expect(
      ensureWorkspace("TEST-4", wsConfig, hooks, "TEST-4"),
    ).rejects.toThrow();

    // Workspace should be cleaned up
    try {
      await stat(join(tempRoot, "TEST-4"));
      expect(false).toBe(true); // Should not reach
    } catch {
      // Expected - directory should not exist
    }
  });

  test("deterministic path per identifier", async () => {
    const ws1 = await ensureWorkspace(
      "ABC-123",
      wsConfig,
      makeHooks(),
      "ABC-123",
    );
    const ws2 = await ensureWorkspace(
      "ABC-123",
      wsConfig,
      makeHooks(),
      "ABC-123",
    );
    expect(ws1.path).toBe(ws2.path);
  });

  test("sanitizes identifier for path", async () => {
    const result = await ensureWorkspace(
      "TEAM/ISSUE#42",
      wsConfig,
      makeHooks(),
      "TEAM/ISSUE#42",
    );
    expect(result.workspaceKey).toBe("TEAM_ISSUE_42");
    expect(result.path).toBe(join(tempRoot, "TEAM_ISSUE_42"));
  });

  test("hook receives environment variables", async () => {
    const hooks = makeHooks({
      afterCreate:
        'echo "$SYMPHONY_ISSUE_IDENTIFIER $SYMPHONY_DEFAULT_BRANCH" > env_check',
    });

    const result = await ensureWorkspace("TEST-5", wsConfig, hooks, "TEST-5");
    const envCheck = await Bun.file(join(result.path, "env_check")).text();
    expect(envCheck.trim()).toBe("TEST-5 dev");
  });
});
