# Startup Networking Agent Guidance

## Project Purpose

This project is a local startup networking control tower. It helps track companies, investors, funding signals, hiring signals, research notes, and next networking actions for sectors including wearables, sports tech, digital health, fitness, AI health, SMB software, and finance/operations software.

## Run Commands

Backend:

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --reload-dir app --port 8000
```

Frontend:

```bash
cd frontend
bun install
bun run dev
```

## Git Hygiene

- Check the worktree before editing when practical.
- Do not revert user changes unless explicitly asked.
- Keep commits focused on the requested feature or fix.
- Do not commit generated dependency folders, build outputs, local databases, secrets, or machine files.
- Do not commit raw Crunchbase CSV exports or other private source-data exports.

Never commit:

- `backend/.venv/`
- `.venv/`
- `frontend/node_modules/`
- `node_modules/`
- `frontend/dist/`
- `dist/`
- `__pycache__/`
- `*.sqlite`
- `*.db`
- SQLite database files such as `data/networking_tracker.db`
- `.env`
- `.DS_Store`
- Raw Crunchbase CSV exports such as `data/imports/*.csv`

## Import Workflow Rules

- Do not scrape Crunchbase.
- Do not add Crunchbase API integrations unless explicitly requested.
- All real data imports must store source metadata such as `data_source`, `last_synced_at`, quality score, and warnings when supported.
- Import workflows should preview parsed rows, field mappings, duplicates, and warnings before confirming writes.
- Agents should disclose source quality and missing data when generating recommendations from imported records.

## Agent Feature Rules

- Keep agent workflows human-in-the-loop.
- Agent output should support user judgment, not take actions automatically.
- Do not add scraping, LinkedIn automation, email sending, background outreach, or external automation without explicit instruction.
- Do not add paid API integrations or real LLM provider calls unless explicitly requested.
- Prefer narrow, inspectable, deterministic agent steps before introducing more complex AI workflows.
- Save agent inputs and outputs so runs can be audited later.
- Agent outputs should be structured, saved to `agent_runs`, action-oriented, and transparent about missing information.

## Done Means

A feature is done when:

- The backend starts locally.
- The frontend builds locally.
- The main happy path has been tested.
- The UI gives useful feedback for loading and error states.
- Any new local files that should not be committed are ignored.
- README or project guidance is updated when run steps, data shape, or workflow behavior changes.
