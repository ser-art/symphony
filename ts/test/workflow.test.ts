// Tests for workflow loader (Section 17.1)
import { describe, test, expect } from "bun:test";
import { parseWorkflowContent, WorkflowError } from "../src/workflow";

describe("Workflow Loader", () => {
  test("parses YAML front matter and prompt body", () => {
    const content = `---
tracker:
  kind: linear
  project_slug: test-slug
---

You are working on {{ issue.identifier }}.`;

    const result = parseWorkflowContent(content);
    expect(result.config).toEqual({
      tracker: { kind: "linear", project_slug: "test-slug" },
    });
    expect(result.promptTemplate).toBe(
      "You are working on {{ issue.identifier }}.",
    );
  });

  test("entire file is prompt when no front matter", () => {
    const content = "Hello, this is a prompt.";
    const result = parseWorkflowContent(content);
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("Hello, this is a prompt.");
  });

  test("empty front matter yields empty config", () => {
    const content = `---
---

Prompt body here.`;

    const result = parseWorkflowContent(content);
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("Prompt body here.");
  });

  test("throws on unclosed front matter", () => {
    const content = `---
tracker:
  kind: linear`;

    expect(() => parseWorkflowContent(content)).toThrow(WorkflowError);
  });

  test("throws on non-map YAML", () => {
    const content = `---
- item1
- item2
---

prompt`;

    expect(() => parseWorkflowContent(content)).toThrow(
      "must be a map/object",
    );
  });

  test("throws on invalid YAML", () => {
    const content = `---
tracker: {
  invalid yaml here
---

prompt`;

    expect(() => parseWorkflowContent(content)).toThrow(WorkflowError);
  });

  test("preserves complex config values", () => {
    const content = `---
tracker:
  kind: linear
  active_states:
    - Todo
    - In Progress
agent:
  max_concurrent_agents: 5
hooks:
  after_create: |
    git clone repo .
---

The prompt.`;

    const result = parseWorkflowContent(content);
    const tracker = result.config.tracker as Record<string, unknown>;
    expect(tracker.kind).toBe("linear");
    expect(tracker.active_states).toEqual(["Todo", "In Progress"]);
    const agent = result.config.agent as Record<string, unknown>;
    expect(agent.max_concurrent_agents).toBe(5);
  });
});
