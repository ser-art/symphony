// Tests for prompt builder (Section 17.1)
import { describe, test, expect } from "bun:test";
import { renderPrompt, PromptError } from "../src/prompt";
import type { Issue } from "../src/types";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "abc123",
    identifier: "TEST-1",
    title: "Fix the bug",
    description: "Something is broken",
    priority: 1,
    state: "In Progress",
    branchName: "test-1-fix-bug",
    url: "https://linear.app/test/issue/TEST-1",
    labels: ["bug", "urgent"],
    blockedBy: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    ...overrides,
  };
}

describe("Prompt Builder", () => {
  test("renders issue fields", async () => {
    const template = "Working on {{ issue.identifier }}: {{ issue.title }}";
    const result = await renderPrompt(template, {
      issue: makeIssue(),
      attempt: null,
      defaultBranch: "dev",
      language: "ru",
    });
    expect(result).toBe("Working on TEST-1: Fix the bug");
  });

  test("renders attempt for retry", async () => {
    const template =
      "{% if attempt %}Retry #{{ attempt }}{% else %}First run{% endif %}";

    const first = await renderPrompt(template, {
      issue: makeIssue(),
      attempt: null,
      defaultBranch: "dev",
      language: "ru",
    });
    expect(first).toBe("First run");

    const retry = await renderPrompt(template, {
      issue: makeIssue(),
      attempt: 3,
      defaultBranch: "dev",
      language: "ru",
    });
    expect(retry).toBe("Retry #3");
  });

  test("renders language variable", async () => {
    const template = "Language: {{ language }}";
    const result = await renderPrompt(template, {
      issue: makeIssue(),
      attempt: null,
      defaultBranch: "dev",
      language: "en",
    });
    expect(result).toBe("Language: en");
  });

  test("renders default_branch variable", async () => {
    const template = "Branch: {{ default_branch }}";
    const result = await renderPrompt(template, {
      issue: makeIssue(),
      attempt: null,
      defaultBranch: "main",
      language: "ru",
    });
    expect(result).toBe("Branch: main");
  });

  test("empty template returns default prompt", async () => {
    const result = await renderPrompt("", {
      issue: makeIssue(),
      attempt: null,
      defaultBranch: "dev",
      language: "ru",
    });
    expect(result).toBe("You are working on an issue from Linear.");
  });

  test("renders issue description with conditional", async () => {
    const template = `{% if issue.description %}{{ issue.description }}{% else %}No description{% endif %}`;

    const withDesc = await renderPrompt(template, {
      issue: makeIssue({ description: "Bug details here" }),
      attempt: null,
      defaultBranch: "dev",
      language: "ru",
    });
    expect(withDesc).toBe("Bug details here");
  });

  test("renders labels as comma-separated string", async () => {
    const template = "Labels: {{ issue.labels }}";
    const result = await renderPrompt(template, {
      issue: makeIssue({ labels: ["bug", "p0"] }),
      attempt: null,
      defaultBranch: "dev",
      language: "ru",
    });
    expect(result).toBe("Labels: bug, p0");
  });
});
