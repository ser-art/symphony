// Symphony TypeScript - Linear Client (Section 11)
// GraphQL client for Linear issue tracker

import type { TrackerConfig } from "../config";
import type { Issue, BlockerRef } from "../types";
import { logger } from "../logger";

export class LinearApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

const PAGE_SIZE = 50;
const NETWORK_TIMEOUT = 30000;

const CANDIDATE_ISSUES_QUERY = `
query CandidateIssues($projectSlug: String!, $states: [String!]!, $after: String) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $states } }
    }
    first: ${PAGE_SIZE}
    after: $after
    orderBy: createdAt
  ) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      identifier
      title
      description
      priority
      branchName
      url
      createdAt
      updatedAt
      state {
        name
      }
      labels {
        nodes {
          name
        }
      }
      inverseRelations(first: 50) {
        nodes {
          type
          issue {
            id
            identifier
            state {
              name
            }
          }
        }
      }
    }
  }
}
`;

const ISSUES_BY_STATES_QUERY = `
query IssuesByStates($projectSlug: String!, $states: [String!]!, $after: String) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $states } }
    }
    first: ${PAGE_SIZE}
    after: $after
  ) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      identifier
      state {
        name
      }
    }
  }
}
`;

const ISSUE_STATES_BY_IDS_QUERY = `
query IssueStatesByIds($ids: [UUID!]!) {
  issues(filter: { id: { in: $ids } }, first: 50) {
    nodes {
      id
      identifier
      title
      description
      priority
      branchName
      url
      createdAt
      updatedAt
      state {
        name
      }
      labels {
        nodes {
          name
        }
      }
      inverseRelations(first: 50) {
        nodes {
          type
          issue {
            id
            identifier
            state {
              name
            }
          }
        }
      }
    }
  }
}
`;

export class LinearClient {
  private endpoint: string;
  private apiKey: string;
  private projectSlug: string;

  constructor(config: TrackerConfig) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.projectSlug = config.projectSlug;
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let cursor: string | null = null;

    while (true) {
      const variables: Record<string, unknown> = {
        projectSlug: this.projectSlug,
        states: activeStates,
      };
      if (cursor) variables.after = cursor;

      const data = await this.graphql(CANDIDATE_ISSUES_QUERY, variables);
      const issues = data?.issues;
      if (!issues?.nodes) {
        throw new LinearApiError(
          "linear_unknown_payload",
          "Unexpected candidate issues response shape",
        );
      }

      for (const node of issues.nodes) {
        allIssues.push(normalizeIssue(node));
      }

      if (!issues.pageInfo?.hasNextPage) break;
      if (!issues.pageInfo.endCursor) {
        throw new LinearApiError(
          "linear_missing_end_cursor",
          "Pagination integrity: missing endCursor",
        );
      }
      cursor = issues.pageInfo.endCursor;
    }

    return allIssues;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    if (states.length === 0) return [];

    const allIssues: Issue[] = [];
    let cursor: string | null = null;

    while (true) {
      const variables: Record<string, unknown> = {
        projectSlug: this.projectSlug,
        states,
      };
      if (cursor) variables.after = cursor;

      const data = await this.graphql(ISSUES_BY_STATES_QUERY, variables);
      const issues = data?.issues;
      if (!issues?.nodes) {
        throw new LinearApiError(
          "linear_unknown_payload",
          "Unexpected issues by states response shape",
        );
      }

      for (const node of issues.nodes) {
        allIssues.push({
          id: node.id,
          identifier: node.identifier,
          title: "",
          description: null,
          priority: null,
          state: node.state?.name ?? "",
          branchName: null,
          url: null,
          labels: [],
          blockedBy: [],
          createdAt: null,
          updatedAt: null,
        });
      }

      if (!issues.pageInfo?.hasNextPage) break;
      if (!issues.pageInfo.endCursor) {
        throw new LinearApiError(
          "linear_missing_end_cursor",
          "Pagination integrity: missing endCursor",
        );
      }
      cursor = issues.pageInfo.endCursor;
    }

    return allIssues;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];

    const data = await this.graphql(ISSUE_STATES_BY_IDS_QUERY, { ids });
    const nodes = data?.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw new LinearApiError(
        "linear_unknown_payload",
        "Unexpected issue states response shape",
      );
    }

    return nodes.filter((n: any) => n?.id).map((n: any) => normalizeIssue(n));
  }

  // Execute raw GraphQL (for linear_graphql tool extension)
  async executeGraphQL(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ data?: unknown; errors?: unknown[] }> {
    const body: Record<string, unknown> = { query };
    if (variables) body.variables = variables;

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT),
    });

    if (!response.ok) {
      throw new LinearApiError(
        "linear_api_status",
        `Linear API returned ${response.status}`,
      );
    }

    return (await response.json()) as { data?: unknown; errors?: unknown[] };
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<any> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT),
      });
    } catch (e) {
      throw new LinearApiError(
        "linear_api_request",
        `Linear API request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (!response.ok) {
      throw new LinearApiError(
        "linear_api_status",
        `Linear API returned ${response.status}: ${response.statusText}`,
      );
    }

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new LinearApiError(
        "linear_unknown_payload",
        "Failed to parse Linear API response as JSON",
      );
    }

    if (body.errors && body.errors.length > 0) {
      const msgs = body.errors.map((e: any) => e.message).join("; ");
      throw new LinearApiError(
        "linear_graphql_errors",
        `Linear GraphQL errors: ${msgs}`,
      );
    }

    return body.data;
  }
}

function normalizeIssue(node: any): Issue {
  const blockedBy: BlockerRef[] = [];

  // From inverseRelations where type is "blocks"
  if (node.inverseRelations?.nodes) {
    for (const rel of node.inverseRelations.nodes) {
      if (rel.type === "blocks" && rel.issue) {
        blockedBy.push({
          id: rel.issue.id ?? null,
          identifier: rel.issue.identifier ?? null,
          state: rel.issue.state?.name ?? null,
        });
      }
    }
  }

  const labels: string[] = [];
  if (node.labels?.nodes) {
    for (const l of node.labels.nodes) {
      if (l.name) labels.push(l.name.toLowerCase());
    }
  }

  const priority = typeof node.priority === "number" ? node.priority : null;

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title ?? "",
    description: node.description ?? null,
    priority,
    state: node.state?.name ?? "",
    branchName: node.branchName ?? null,
    url: node.url ?? null,
    labels,
    blockedBy,
    createdAt: node.createdAt ? new Date(node.createdAt) : null,
    updatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}
