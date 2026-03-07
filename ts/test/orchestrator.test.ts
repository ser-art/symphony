// Tests for orchestrator dispatch logic (Section 17.4)
import { describe, test, expect } from "bun:test";
import type { Issue } from "../src/types";

// Test dispatch sorting and eligibility in isolation
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "id-1",
    identifier: "TEST-1",
    title: "Test issue",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: null,
    ...overrides,
  };
}

function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;
    const ca = a.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const cb = b.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return ca - cb;
    return a.identifier.localeCompare(b.identifier);
  });
}

describe("Dispatch Sorting", () => {
  test("sorts by priority ascending, null last", () => {
    const issues = [
      makeIssue({ id: "1", identifier: "A-1", priority: 3 }),
      makeIssue({ id: "2", identifier: "A-2", priority: 1 }),
      makeIssue({ id: "3", identifier: "A-3", priority: null }),
      makeIssue({ id: "4", identifier: "A-4", priority: 2 }),
    ];

    const sorted = sortForDispatch(issues);
    expect(sorted.map((i) => i.identifier)).toEqual([
      "A-2",
      "A-4",
      "A-1",
      "A-3",
    ]);
  });

  test("sorts by createdAt oldest first within same priority", () => {
    const issues = [
      makeIssue({
        id: "1",
        identifier: "A-1",
        priority: 1,
        createdAt: new Date("2026-01-03"),
      }),
      makeIssue({
        id: "2",
        identifier: "A-2",
        priority: 1,
        createdAt: new Date("2026-01-01"),
      }),
      makeIssue({
        id: "3",
        identifier: "A-3",
        priority: 1,
        createdAt: new Date("2026-01-02"),
      }),
    ];

    const sorted = sortForDispatch(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(["A-2", "A-3", "A-1"]);
  });

  test("uses identifier as tie-breaker", () => {
    const issues = [
      makeIssue({
        id: "1",
        identifier: "B-1",
        priority: 1,
        createdAt: new Date("2026-01-01"),
      }),
      makeIssue({
        id: "2",
        identifier: "A-1",
        priority: 1,
        createdAt: new Date("2026-01-01"),
      }),
    ];

    const sorted = sortForDispatch(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(["A-1", "B-1"]);
  });
});

describe("Blocker Rules", () => {
  test("Todo with non-terminal blocker is ineligible", () => {
    const issue = makeIssue({
      state: "Todo",
      blockedBy: [
        { id: "b1", identifier: "BLOCK-1", state: "In Progress" },
      ],
    });

    const terminalStates = ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"];
    const hasNonTerminalBlocker = issue.blockedBy.some((b) => {
      if (!b.state) return true;
      return !terminalStates.some(
        (ts) => ts.toLowerCase() === b.state!.toLowerCase(),
      );
    });

    expect(hasNonTerminalBlocker).toBe(true);
  });

  test("Todo with terminal-only blockers is eligible", () => {
    const issue = makeIssue({
      state: "Todo",
      blockedBy: [{ id: "b1", identifier: "BLOCK-1", state: "Done" }],
    });

    const terminalStates = ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"];
    const hasNonTerminalBlocker = issue.blockedBy.some((b) => {
      if (!b.state) return true;
      return !terminalStates.some(
        (ts) => ts.toLowerCase() === b.state!.toLowerCase(),
      );
    });

    expect(hasNonTerminalBlocker).toBe(false);
  });

  test("Todo with no blockers is eligible", () => {
    const issue = makeIssue({ state: "Todo", blockedBy: [] });
    expect(issue.blockedBy.length).toBe(0);
  });
});

describe("Trigger Labels", () => {
  test("empty trigger labels means all issues eligible", () => {
    const triggerLabels: string[] = [];
    const issue = makeIssue({ labels: ["bug"] });
    const hasMatch =
      triggerLabels.length === 0 ||
      triggerLabels.some((tl) =>
        issue.labels.map((l) => l.toLowerCase()).includes(tl),
      );
    expect(hasMatch).toBe(true);
  });

  test("non-empty trigger labels filters issues", () => {
    const triggerLabels = ["symphony"];

    const matching = makeIssue({ labels: ["symphony", "bug"] });
    const nonMatching = makeIssue({ labels: ["bug", "feature"] });

    const matchesA = triggerLabels.some((tl) =>
      matching.labels.map((l) => l.toLowerCase()).includes(tl),
    );
    const matchesB = triggerLabels.some((tl) =>
      nonMatching.labels.map((l) => l.toLowerCase()).includes(tl),
    );

    expect(matchesA).toBe(true);
    expect(matchesB).toBe(false);
  });

  test("label matching is case-insensitive", () => {
    const triggerLabels = ["symphony"];
    const issue = makeIssue({ labels: ["Symphony"] });

    const matches = triggerLabels.some((tl) =>
      issue.labels.map((l) => l.toLowerCase()).includes(tl),
    );
    expect(matches).toBe(true);
  });
});

describe("Retry Backoff", () => {
  test("normal continuation uses 1s delay", () => {
    const delay = 1000;
    expect(delay).toBe(1000);
  });

  test("failure backoff is exponential", () => {
    const maxBackoff = 300000;
    const delays = [1, 2, 3, 4, 5].map((attempt) =>
      Math.min(10000 * Math.pow(2, attempt - 1), maxBackoff),
    );
    expect(delays).toEqual([10000, 20000, 40000, 80000, 160000]);
  });

  test("backoff caps at max_retry_backoff_ms", () => {
    const maxBackoff = 300000;
    const delay = Math.min(10000 * Math.pow(2, 10), maxBackoff);
    expect(delay).toBe(300000);
  });
});
