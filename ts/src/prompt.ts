// Symphony TypeScript - Prompt Builder (Section 12)
// Strict Liquid-compatible template rendering

import { Liquid } from "liquidjs";
import type { Issue } from "./types";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export class PromptError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromptError";
  }
}

export interface PromptContext {
  issue: Issue;
  attempt: number | null;
  defaultBranch: string;
  language: string;
}

function issueToTemplateObj(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName ?? "",
    url: issue.url ?? "",
    labels: issue.labels.join(", "),
    blocked_by: issue.blockedBy.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    created_at: issue.createdAt?.toISOString() ?? "",
    updated_at: issue.updatedAt?.toISOString() ?? "",
  };
}

export async function renderPrompt(
  template: string,
  ctx: PromptContext,
): Promise<string> {
  if (!template.trim()) {
    return "You are working on an issue from Linear.";
  }

  const vars = {
    issue: issueToTemplateObj(ctx.issue),
    attempt: ctx.attempt,
    default_branch: ctx.defaultBranch,
    language: ctx.language,
  };

  try {
    return await engine.parseAndRender(template, vars);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("undefined variable") || msg.includes("not found")) {
      throw new PromptError("template_render_error", `Template render: ${msg}`);
    }
    throw new PromptError("template_parse_error", `Template parse: ${msg}`);
  }
}
