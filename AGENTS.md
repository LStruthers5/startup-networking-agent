# Startup Networking Agent Guidance

## Project Purpose

This project is a local startup networking control tower. It helps track companies, investors, funding signals, hiring signals, research notes, and next networking actions for sectors including wearables, sports tech, digital health, fitness, AI health, SMB software, and finance/operations software.

## Run Commands

Backend:

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --reload-dir app --port 8002
```

Frontend:

```bash
cd frontend
bun install
bun run dev
```

Demo URL:

```text
http://localhost:5174
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

## Investor Enrichment Rules

- Do not overwrite manually entered relationship fields unless they are blank.
- Derived investor fields such as tracked company counts, lead counts, sector focus, stage focus, overlap summaries, missing fields, warnings, and priority scores can be recalculated.
- Research links are allowed because they are user-clicked shortcuts.
- Scraping is not allowed unless explicitly requested.
- Prioritize automation that saves human research time and avoids unnecessary Crunchbase export usage.

## Action Queue Rules

- Agent outputs should inform action items, but action items must remain human-in-the-loop.
- Outreach only sends automatically for drafts explicitly marked `stakes_tier='low'` at creation time (cold reach — never a warm-intro path — to the lowest investor priority tier, with a real email on file), and only after a 3-hour cancel window the user can cancel from either the app or the email notice. Every other draft — any warm intro, any higher-priority target, or anything without a confirmed email — always requires an explicit human approval click. The send trigger itself (`runScheduledAutoSends` in `server/scheduler.js`) is pure deterministic SQL, never an LLM decision.
- Avoid duplicate open action items for the same target and action type.
- Preserve user-entered action notes, statuses, due dates, and outreach drafts when rebuilding queues.
- Prioritize actions that create useful conversations or unblock outreach.

## Done Means

A feature is done when:

- The backend starts locally.
- The frontend builds locally.
- The main happy path has been tested.
- The UI gives useful feedback for loading and error states.
- Any new local files that should not be committed are ignored.
- README or project guidance is updated when run steps, data shape, or workflow behavior changes.
