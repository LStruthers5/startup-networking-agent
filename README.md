# Startup Networking Agent

A local MVP for tracking realistic startup networking leads in wearables, sports tech, digital health, fitness, AI health, SMB software, and finance/operations software.

## Agent Control Tower (Node Deployment)

The Railway-facing Node application in `server/` and `client/` includes an always-on Agent Control Tower:

- A unified registry for native and imported Dust agents.
- A metered run ledger with trigger, status, duration, provider calls, token usage, exact/estimated cost, failures, and output yield.
- Historical pricing snapshots. Claude Sonnet 4.6 defaults to the published $3 input / $15 output per million token pricing; Exa remains an explicitly labeled configurable estimate.
- A normalized information river linking agent runs to companies, people, events, claims, drafts, and recommended actions.
- Daily targets, hard monthly ceilings, spend forecasts, per-agent economics, and lean/current/aggressive scenario previews.
- Agent-derived Outreach Tuner cards. Human choices credit or reject the originating signals.
- Versioned adaptive-agent proposals with approval and rollback. Prompt, search, schedule, and workflow changes are never silently applied.
- Optional Dust agent registration by configuration ID and blocking programmatic execution through the same registry and ledger. Dust requires OAuth to list agents, so API-key integrations add Company/Shared agents explicitly.
- An automated intelligence loop: company monitoring → evidence auditing → bounded Dust investigation → relationship paths → follow-up strategy → outcome learning → reviewable agent-budget proposals.

Run this deployment locally with:

```bash
cp .env.example .env
npm install
npm start
```

The Node app uses PostgreSQL via `DATABASE_URL` and serves the UI at `http://localhost:3000` by default. The existing Python/React prototype below remains a separate application stack.

Optional Dust setup requires `DUST_API_KEY` and `DUST_WORKSPACE_ID`. Dust workspace allowances, trigger allowances, and programmatic credits are entered in the Control Tower settings because they are separate economic buckets. Almost every draft still requires human approval — the one exception is a narrow, explicit auto-send tier: cold reaches (never a warm intro) to the lowest investor priority tier, only once a real email is on file, send automatically after a 3-hour cancel window. Anything above that tier always waits for a click.

The app is designed for manual Crunchbase Pro CSV exports. It does not use Crunchbase APIs, scraping, email sending, LinkedIn automation, authentication, or paid integrations.

## What It Does

- Imports company CSVs into a local SQLite database.
- Shows a Companies dashboard with filters for sector, location, status, minimum total score, funding round, and investor name.
- Tracks editable research fields for each company: market fit, personal fit, hiring fit, network fit, status, notes, next action, and outreach angle.
- Calculates total score from the four fit scores.
- Shows expandable company detail rows with summary, funding, investors, score controls, notes, next action, and outreach angle.
- Maintains an Investors section with thesis tags, portfolio companies, relevant partner, contact path, priority score, and notes.
- Seeds sample company and investor data so the app is usable immediately.

## Project Structure

```text
backend/
  app/
    database.py
    main.py
    models.py
  requirements.txt
frontend/
  src/
    main.jsx
    styles.css
  package.json
  vite.config.js
data/
  sample_companies.csv
```

## Run The Backend

From the repo root:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --reload-dir app --port 8002
```

The API runs at `http://127.0.0.1:8002`.

The `--reload-dir app` flag keeps the backend watcher focused on application code and prevents reload churn from `.venv` or generated files.

The SQLite database is created at `data/networking_tracker.db` on first startup.

## Debugging Backend/Database Issues

Start the backend:

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --reload-dir app --port 8002
```

Check health:

```bash
curl --max-time 5 http://127.0.0.1:8002/health
```

Check the SQLite database path, size, counts, and sample companies:

```bash
curl --max-time 5 http://127.0.0.1:8002/debug/db
```

Check the company list endpoint:

```bash
curl --max-time 10 http://127.0.0.1:8002/companies
curl --max-time 10 "http://127.0.0.1:8002/companies?limit=20"
```

Find local database files:

```bash
find . -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3"
```

The canonical SQLite path is resolved from the backend package location, not the shell working directory, so uvicorn should use the same database when started with the documented command.

## Run The Frontend

In a second terminal, from the repo root:

```bash
cd frontend
bun install
bun run dev
```

Open `http://localhost:5174`.

If you prefer npm and have a modern Node version installed, `npm install` and `npm run dev` also work.

## Running Alongside PointTracer

For demos, PointTracer can keep using its usual ports, such as frontend `http://localhost:5173` and backend `http://127.0.0.1:8000`.

This startup networking app uses dedicated ports:

- Frontend: `http://localhost:5174`
- Backend: `http://127.0.0.1:8002`

Vite is configured with `strictPort: true`, so `bun run dev` fails clearly instead of silently moving to another port if `5174` is busy.

## Import A CSV

1. Start both the backend and frontend.
2. Open the Companies dashboard.
3. Click `Import CSV`.
4. Choose a CSV exported from Crunchbase or use `data/sample_companies.csv`.

Expected CSV headers:

```csv
company_name,sector,description,location,website,latest_funding_round,funding_amount,funding_date,lead_investors,other_investors,employee_count,crunchbase_url,careers_url
```

Only `company_name` is required. Existing companies are updated by case-insensitive company name. New investor names found in `lead_investors` or `other_investors` are added to the Investors section.

## Crunchbase CSV Import Workflow

Use the Import Center for real Crunchbase exports:

1. Build a Crunchbase search or list for the sectors you care about.
2. Export the result as a CSV.
3. Save the raw CSV locally in `data/imports/`.
4. Do not commit raw Crunchbase exports. `data/imports/*.csv` is ignored.
5. Start the app and open `Import Center`.
6. Upload the CSV and click `Preview Import`.
7. Review detected columns, proposed mappings, duplicates, investors to create, row quality scores, and warnings.
8. Click `Confirm Import` to upsert companies and investor records.
9. Go back to Companies and run the Company Networking Brief Agent or Investor Mapping Agent on imported companies.

The import maps common Crunchbase columns such as `Organization Name`, `Industries`, `Headquarters Location`, `Last Funding Type`, `Lead Investors`, `Top 5 Investors`, `LinkedIn`, `Founders`, `CB Rank (Company)`, and `Crunchbase URL` into local company fields. Imported rows are labeled with `data_source = "Crunchbase CSV"`, `last_synced_at`, `data_quality_score`, and saved warnings when data is incomplete.

Preview from the API:

```bash
curl -X POST http://127.0.0.1:8002/imports/crunchbase/preview \
  -F "file=@../data/imports/crunchbase_first_batch.csv"
```

Confirm from the API:

```bash
curl -X POST http://127.0.0.1:8002/imports/crunchbase/confirm \
  -F "file=@../data/imports/crunchbase_first_batch.csv"
```

## API Endpoints

- `GET /health`
- `GET /debug/db`
- `GET /companies`
- `GET /companies/{company_id}`
- `DELETE /companies/{company_id}`
- `GET /api/health`
- `GET /api/companies`
- `GET /api/companies/{company_id}`
- `DELETE /api/companies/{company_id}`
- `PATCH /api/companies/{company_id}`
- `POST /api/import/companies`
- `GET /api/filter-options`
- `GET /filter-options`
- `GET /api/investors`
- `POST /api/investors`
- `PATCH /api/investors/{investor_id}`
- `GET /investors`
- `POST /investors`
- `PATCH /investors/{investor_id}`
- `POST /agents/company-brief/{company_id}`
- `GET /agents/company-brief/{company_id}/runs`
- `POST /agents/investor-map/company/{company_id}`
- `GET /agents/investor-map/company/{company_id}/runs`
- `POST /imports/crunchbase/preview`
- `POST /imports/crunchbase/confirm`
- `POST /investors/rebuild-profiles`
- `GET /investors/enrichment-queue`
- `POST /actions/rebuild-weekly`
- `GET /actions`
- `GET /actions/weekly`
- `PATCH /actions/{action_id}`
- `DELETE /actions/{action_id}`
- `POST /actions/{action_id}/generate-outreach-draft`

## Investor Profile + Enrichment Engine

The Investor Profile + Enrichment Engine turns already-imported company data into ranked investor profiles without using more Crunchbase exports. It reads local `lead_investors`, `other_investors`, company sectors, funding stages, funding dates, fit scores, notes, and existing investor records, then rebuilds derived investor fields.

It helps answer:

- Which investors appear across the most tracked companies
- Which investors are lead investors
- Which investors overlap with target sectors and stages
- Which investors are tied to high-fit companies
- Which investors still need partner, contact-path, website, LinkedIn, or Crunchbase research
- Which investor should be researched or contacted first

To rebuild profiles after importing Crunchbase CSV data:

```bash
curl -X POST http://127.0.0.1:8002/investors/rebuild-profiles
```

To view the enrichment queue:

```bash
curl http://127.0.0.1:8002/investors/enrichment-queue
```

From the UI:

1. Open `Investors`.
2. Click `Rebuild Investor Profiles`.
3. Review priority score, tracked company count, lead count, thesis tags, missing data, and next action.
4. Open an investor detail row.
5. Add relationship fields like relevant partner, partner LinkedIn, contact path, talent/platform contact, relationship strength, next action, and notes.

Priority score is 0-100. The engine adds weight for lead investments, high-fit companies, repeated appearances, target-sector overlap, Seed/Series A/Series B focus, contact paths, and relevant partners. It subtracts weight when an investor has no firm URL data or no relationship data.

Research shortcuts are generated links only. They point to Google, LinkedIn search, Crunchbase search, portfolio search, partner/sector search, and funding-round search for the top tracked company. The app does not scrape these pages; the links just save time and avoid burning extra Crunchbase export rows.

Companies can be deleted from an expanded company row. Deleting a company also removes saved agent runs for that company, but it does not delete investor records; rebuild investor profiles afterward if you want derived portfolio counts to reflect the deletion.

## Weekly Action Queue

The Weekly Action Queue turns existing local company, investor, and agent-run data into prioritized research and networking tasks. It helps answer what to research next, which investor profiles need enrichment, which companies need hiring validation, what missing fields block outreach, and which targets are ready for a human-reviewed outreach step.

Rebuild the weekly queue:

```bash
curl -X POST http://127.0.0.1:8002/actions/rebuild-weekly
```

View open weekly actions:

```bash
curl http://127.0.0.1:8002/actions/weekly
```

Generate an editable outreach draft for one action:

```bash
curl -X POST http://127.0.0.1:8002/actions/1/generate-outreach-draft
```

From the UI, open `This Week`, click `Rebuild Weekly Queue`, then mark actions in progress, done, or skipped. Outreach drafts are deterministic text helpers saved into the action item; the app never sends outreach automatically.

Priority scores use local signals: high-fit companies, actions that unblock outreach, lead investors, investors appearing across multiple tracked companies, Crunchbase CSV source data, Seed/Series A/Series B stage, saved contact paths, missing critical fields, and low data quality. Research links are generated shortcuts only and do not scrape any page.

## AI Agent Workflows

### Company Networking Brief Agent

The Company Networking Brief Agent generates a structured networking brief from one saved company record. It uses the company profile, funding fields, investors, scores, notes, next action, and outreach angle to produce:

- Company snapshot
- Thesis fit
- Investor networking path
- Hiring signal
- Suggested outreach angle
- Smart questions
- Recommended next action
- Missing information
- Confidence score

The first version is deterministic and template-based. It does not call an LLM provider, scrape websites, send email, or automate LinkedIn. Each generated run is saved in the `agent_runs` table with the input snapshot and output JSON for later review.

To run it from the UI:

1. Start the backend and frontend.
2. Expand a company row.
3. Click `Generate Networking Brief`.
4. Review the latest brief and previous runs in the company detail panel.

To test it from the API:

```bash
curl -X POST http://127.0.0.1:8002/agents/company-brief/1
curl http://127.0.0.1:8002/agents/company-brief/1/runs
```

Later, this workflow can be upgraded by replacing the deterministic `generate_company_networking_brief(company)` function with a real LLM provider call. The endpoint and database shape can stay mostly the same: gather a company snapshot, send it to the provider with a structured-output schema, validate the response, save the run, and show it in the same UI.

For imported Crunchbase companies, the brief discloses that source context, includes the Crunchbase URL when available, uses saved data warnings as missing information, and lowers confidence when the import quality score is low.

### Investor Mapping Agent

The Investor Mapping Agent turns one company's funding and investor data into a control-tower-style relationship map for networking decisions. It classifies the company by sector, likely investor thesis, stage signal, and networking relevance, then ranks investor paths and highlights what relationship data is still missing.

It is inspired by market-mapping products like BCG's FinTech Control Tower, but narrowed for a job-search workflow:

- Taxonomy-style classification of sector, thesis, and stage
- Funding relationship tracing from company to lead and other investors
- Relationship-map output showing investor -> why they matter -> next action
- Deep-profile context from company notes, fit scores, and linked investor records
- Strategic next-step recommendations that remain human-in-the-loop

To run it from the UI:

1. Start the backend and frontend.
2. Expand a company row.
3. Click `Generate Investor Map`.
4. Review the latest investor map and previous runs in the company detail panel.

To test it from the API:

```bash
curl -X POST http://127.0.0.1:8002/agents/investor-map/company/1
curl http://127.0.0.1:8002/agents/investor-map/company/1/runs
```

The Investor Mapping Agent differs from the Company Networking Brief Agent by focusing specifically on investor and portfolio paths: which investor matters most, why that investor matters, what first networking move is most useful, and what relationship data should be researched before outreach.

For imported Crunchbase companies, the map uses saved lead and other investor data, discloses import quality, and treats missing relationship details as research tasks before outreach.

## Next Product Steps

1. Add saved views like `High Priority`, `Needs Investor Map`, and `Ready For Outreach`.
2. Add a Contacts table linked to companies and investors.
3. Add outreach draft fields and templates, still without sending email.
4. Add richer CSV column mapping for messy Crunchbase exports.
5. Add duplicate detection and merge tools for companies and investors.
6. Add lightweight analytics: funding momentum, hiring signal, top sectors, and investor overlap.
7. Add optional local AI assistance for outreach angle generation after the core tracker is stable.
