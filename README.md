# Startup Networking Agent

A local MVP for tracking realistic startup networking leads in wearables, sports tech, digital health, fitness, AI health, SMB software, and finance/operations software.

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
uvicorn app.main:app --reload --reload-dir app --port 8000
```

The API runs at `http://127.0.0.1:8000`.

The `--reload-dir app` flag keeps the backend watcher focused on application code and prevents reload churn from `.venv` or generated files.

The SQLite database is created at `data/networking_tracker.db` on first startup.

## Run The Frontend

In a second terminal, from the repo root:

```bash
cd frontend
bun install
bun run dev
```

Open `http://127.0.0.1:5173`.

If you prefer npm and have a modern Node version installed, `npm install` and `npm run dev` also work.

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
curl -X POST http://127.0.0.1:8000/imports/crunchbase/preview \
  -F "file=@../data/imports/crunchbase_first_batch.csv"
```

Confirm from the API:

```bash
curl -X POST http://127.0.0.1:8000/imports/crunchbase/confirm \
  -F "file=@../data/imports/crunchbase_first_batch.csv"
```

## API Endpoints

- `GET /api/health`
- `GET /api/companies`
- `GET /api/companies/{company_id}`
- `PATCH /api/companies/{company_id}`
- `POST /api/import/companies`
- `GET /api/filter-options`
- `GET /api/investors`
- `POST /api/investors`
- `PATCH /api/investors/{investor_id}`
- `POST /agents/company-brief/{company_id}`
- `GET /agents/company-brief/{company_id}/runs`
- `POST /agents/investor-map/company/{company_id}`
- `GET /agents/investor-map/company/{company_id}/runs`
- `POST /imports/crunchbase/preview`
- `POST /imports/crunchbase/confirm`

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
curl -X POST http://127.0.0.1:8000/agents/company-brief/1
curl http://127.0.0.1:8000/agents/company-brief/1/runs
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
curl -X POST http://127.0.0.1:8000/agents/investor-map/company/1
curl http://127.0.0.1:8000/agents/investor-map/company/1/runs
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
