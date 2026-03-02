# Google Workspace MCP Server

## Development Workflow

### Branching
Always create a feature branch off `main` before making changes. Never commit directly to `main`. Use descriptive branch names (e.g., `feat/auth-oauth`, `fix/token-refresh`).

### Before pushing / opening a PR
1. Run CodeRabbit code review on changes:
   ```
   /coderabbit:review
   ```
2. Address any issues found.
3. Re-run CodeRabbit review. Repeat until there are zero issues.
4. Push the branch and open a PR against `main`.

### Agent Teams
Use agent teams (TeamCreate + Agent tool) when tasks can be parallelized. Examples:
- Implementing multiple independent services simultaneously (e.g., Drive, Sheets, Gmail services)
- Running code review in parallel with test writing
- Researching API docs while another agent implements
