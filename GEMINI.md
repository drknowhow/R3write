## C3 Tools — MANDATORY (enforced by hooks)
Native tools (Read, Grep, Glob, Edit, Write) are **blocked by PreToolUse hooks** unless a c3_* tool was called first. Do NOT attempt native tools without prior c3_* usage — they will be denied.

**Native tools are permitted ONLY when:**
1. The c3_* tool failed or returned an error
2. The c3_* tool returned insufficient scope for a targeted follow-up
When falling back, state which c3_* tool was attempted and why it was insufficient.

## Workflow (follow this order — do not skip steps)
1. **RECALL**: `c3_memory(action='recall')` — before any multi-step or context-dependent task. Large memory stores: use `index` first (compact list), then `fetch` for specific IDs
2. **SEARCH FIRST**: `c3_search(action='code|files|semantic')` — before ANY file discovery or content search. Never start with Grep/Glob
3. **MAP before READ**: `c3_compress(mode='map')` then `c3_read(symbols=...|lines=...)` — for ANY file read. Never start with native Read. Use `mode='ast'` for knowledge-graph overview (requires codebase-memory-mcp)
4. **IMPACT** (shared symbols): `c3_impact(target='symbol')` — blast-radius check before editing any function/class used across files
5. **EDIT via C3**: `c3_edit(file_path, old_string, new_string, summary)` — for ALL edits. Parallel across files; `edits=[]` batch for same file
6. **FILTER**: `c3_filter(text=...)` — for terminal output >10 lines or log files
6.5. **SHELL via C3**: `c3_shell(cmd, cwd='', timeout=60)` — for tests, git, build, scripts. Returns structured `{exit_code, stdout, stderr, duration_ms}`. Auto-filters stdout >30 lines; auto-logs git-mutating commands (commit/add/merge/rebase/reset/restore/checkout) to the edit ledger. Blocks fork bombs and `rm -rf /` or `~`; soft-warns on `--force`, `--no-verify`, `reset --hard`. Native Bash remains the fallback for interactive/TTY commands
7. **VALIDATE**: `c3_validate(file_path)` — after edits or before reporting done. Runs deep type check (pyright/tsc) automatically if installed
8. **LOG**: `c3_session(action='log')` for decisions. `c3_session(action='snapshot')` before /clear
9. **DELEGATE**: `c3_delegate(task, backend='ollama|codex|gemini|claude|auto')` or `c3_agent(workflow=...)` for multi-model pipelines
10. **BITBUCKET** (when configured, v2.30.0+): `c3_bitbucket(action='...')` — for self-hosted enterprise Bitbucket Data Center / Server: PRs, branches, builds, repo admin. Tokens live in the OS keyring (set up via `c3 bitbucket login`). Read actions are safe in plan mode; write actions (`merge_pr`, `create_branch`, etc.) are auto-logged to the edit ledger.

## Plan mode
In plan mode, all c3_* read tools (search, read, compress, filter, validate, status) work normally — skip edit/delegate steps.

## Anti-patterns (DO NOT do these)
- Starting with native file search/read/grep without a prior c3_* call
- Using native Edit when c3_edit is available
- Reading entire files when c3_compress + c3_read would be more surgical
- Skipping c3_validate after making edits

## IDE Configuration (Gemini CLI)
This project uses project-scoped MCP servers. Ensure your `.gemini/settings.json` includes:
```json
{
  "mcpServers": {
    "c3": {
      "command": "python",
      "args": ["U:/1. Projects/Claude Code Companion (C3)/claude-companion - v2/cli/mcp_server.py", "--project", "."]
    }
  }
}
```

## Gemini Enforcement
- `c3 init` and `c3 install-mcp` install this file as a required workflow, not a suggestion.
- After install, use the `c3` MCP server for recall, search, structural mapping, surgical reads, filtering, and session logging before native Gemini repo exploration.
- Do not bypass C3 with broad native search/read steps unless a matching `c3_*` tool failed or was too narrow for a final follow-up.
- If fallback is necessary, say which `c3_*` tool was attempted or skipped and why.

---

# Project Context

```
R3write/
  .gitignore
  .mcp.json
  AGENTS.md
  CHANGELOG.md
  CLAUDE.md
  GEMINI.md
  README.md
  index.html
  package-lock.json
  package.json
  tsconfig.json
  tsconfig.tsbuildinfo
  vite.config.ts
  .claude/
    settings.local.json
  src/
    banner.png
    icon.png
    index.css
    main.tsx
    theme.ts
  src-tauri/
    Cargo.lock
    Cargo.toml
    build.rs
    tauri.conf.json
    capabilities/ (1 files)
    gen/
    icons/ (17 files)
    src/ (1 files)
    target/ (2 files)
```

## Tech Stack

Node.js, TypeScript, Vite, React