# Google Workspace MCP Server

## Development Workflow

### Branching
Always create a feature branch off `main` before making changes. Never commit directly to `main`. Use descriptive branch names (e.g., `feat/auth-oauth`, `fix/token-refresh`).

### Pull requests
1. Open every pull request against `main` as a draft.
2. Strictly self-review the full diff (`git diff main...HEAD`) before marking it ready for review.
3. The central `codex-review` gate reviews the pull request once it is ready (drafts are not
   reviewed) and posts the required `codex-review` check. Address its findings and push; it reviews
   again on every push.

### Agent Teams
Use agent teams (TeamCreate + Agent tool) when tasks can be parallelized. Examples:
- Implementing multiple independent services simultaneously (e.g., Drive, Sheets, Gmail services)
- Running code review in parallel with test writing
- Researching API docs while another agent implements
