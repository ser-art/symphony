# Maintaining CLAUDE.md

This document describes the format, principles, and maintenance workflow for the
root `CLAUDE.md` file and its `agents.md` symlink.

## Purpose

`CLAUDE.md` is a compressed index that tells Claude Code (and Codex, via the
`agents.md` symlink) where to find project documentation. It does **not** embed
content — it points to it.

## Format

The file uses a pipe-delimited, numbered-section format:

```
[Project Name]
|root: ./
|IMPORTANT: <constraint>

|NN-section:{file1.md, dir/file2.md}
  One-line description of what these files cover.
```

### Rules

- **Numbered sections** (`|01-`, `|02-`, ...) group related files by topic.
- **Curly braces** list the files or directories the section refers to.
- **Indented lines** below a section header are brief descriptions (1-2 lines).
- **`|IMPORTANT:`** lines are global constraints that apply to all work.
- Keep the total file size **under 4 KB**. This ensures it fits comfortably in
  the agent's context window without crowding out working memory.

## Principles

1. **Retrieval-led**: The index tells the agent *where* to look, not *what* to
   do. The agent reads the referenced files before acting.
2. **Point, don't embed**: Never paste code, specs, or long instructions into
   `CLAUDE.md`. Link to the source file instead.
3. **Minimal**: Every line should earn its place. If removing a line doesn't
   change agent behavior, remove it.

## When to Update

Update `CLAUDE.md` when:

- A new documentation file is added to the repo.
- An existing doc file is renamed or moved.
- A new behavioral constraint applies to all agent work (add an `|IMPORTANT:`).
- A new skill/command directory is introduced.

Do **not** update `CLAUDE.md` for:

- Code changes that don't affect documentation structure.
- Content changes within existing doc files (the agent reads them on demand).

## Symlink Maintenance

`AGENTS.md` is a symlink to `CLAUDE.md`:

```
AGENTS.md -> CLAUDE.md
```

This ensures both Codex (which reads `AGENTS.md`) and Claude Code (which reads
`CLAUDE.md`) see the same index. If you rename or move `CLAUDE.md`, update the
symlink.

To verify:

```bash
ls -la AGENTS.md
# Should show: AGENTS.md -> CLAUDE.md
```

To recreate if broken:

```bash
ln -sf CLAUDE.md AGENTS.md
```

## Anti-Patterns

- **Embedding code or specs**: Don't paste implementation details. Link to the
  file with a `|NN-section:{path}` entry.
- **Large sections**: If a section description exceeds 3 lines, the referenced
  file should contain the detail, not the index.
- **Duplicating SPEC.md**: The spec is authoritative. Don't summarize it in
  `CLAUDE.md` — just point to it.
- **Stale entries**: If a referenced file no longer exists, remove the entry.
  A broken pointer is worse than no pointer.

## Template

```
[Project Name]
|root: ./
|IMPORTANT: <global constraint 1>
|IMPORTANT: <global constraint 2>

|01-spec:{path/to/spec.md}
  What the spec covers.

|02-implementation:{path/to/README.md, path/to/GUIDE.md}
  What these implementation docs cover.

|03-docs:{path/to/docs/}
  Topic area these docs address.

|04-project-meta:{README.md, LICENSE, .github/pull_request_template.md}
  Repo metadata and contribution guidelines.

|05-skills:{.claude/commands/, .codex/skills/}
  Agent command/skill definitions.

|06-conventions:
  - Convention 1
  - Convention 2
```
