// Symphony TypeScript - Workflow Loader (Section 5)
// Reads WORKFLOW.md, parses YAML front matter + prompt body

import { readFile } from "fs/promises";
import { parse as parseYaml } from "yaml";
import type { WorkflowDefinition } from "./types";

export class WorkflowError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export async function loadWorkflow(
  filePath: string,
): Promise<WorkflowDefinition> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    throw new WorkflowError(
      "missing_workflow_file",
      `Cannot read workflow file: ${filePath}`,
    );
  }

  return parseWorkflowContent(content);
}

export function parseWorkflowContent(content: string): WorkflowDefinition {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    // No front matter - entire file is prompt body
    return { config: {}, promptTemplate: content.trim() };
  }

  // Find closing ---
  const afterFirst = trimmed.slice(3);
  const closingIdx = afterFirst.indexOf("\n---");
  if (closingIdx === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      "YAML front matter not closed (missing closing ---)",
    );
  }

  const yamlStr = afterFirst.slice(0, closingIdx);
  const promptBody = afterFirst.slice(closingIdx + 4).trim();

  let config: unknown;
  try {
    config = parseYaml(yamlStr);
  } catch (e) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Invalid YAML front matter: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Empty YAML or null parses as null
  if (config === null || config === undefined) {
    config = {};
  }

  if (typeof config !== "object" || Array.isArray(config)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "YAML front matter must be a map/object",
    );
  }

  return {
    config: config as Record<string, unknown>,
    promptTemplate: promptBody,
  };
}
