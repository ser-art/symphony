[Symphony Docs Index]
|root: ./
|IMPORTANT: Prefer retrieval-led reasoning. Read referenced files before acting.
|IMPORTANT: Public repo — no secrets, no company-specific config allowed.
|IMPORTANT: Elixir implementation is reference only. Own implementation TBD (likely Go).

|01-spec:{SPEC.md}
  Authoritative language-agnostic specification. Read first for any architectural question.

|02-reference-impl:{elixir/README.md, elixir/AGENTS.md, elixir/WORKFLOW.md}
  Elixir/OTP reference implementation. Use as design reference only.

|03-docs:{elixir/docs/logging.md}
  Structured logging conventions.

|04-project-meta:{README.md, LICENSE, .github/pull_request_template.md}
  PR body must follow the template exactly.

|05-skills:{.claude/commands/, .codex/skills/}
  Claude Code: .claude/commands/<name>.md
  Codex: .codex/skills/<name>/SKILL.md

|06-conventions:
  - Conventional commits: type(scope): subject
  - gh CLI for all GitHub ops
  - No --force; only --force-with-lease as last resort
  - Agent comments prefixed [claude] or [codex]
  - Run validation gate before pushing
