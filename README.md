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
uvicorn app.main:app --reload
```

The API runs at `http://127.0.0.1:8000`.

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

## Next Product Steps

1. Add saved views like `High Priority`, `Needs Investor Map`, and `Ready For Outreach`.
2. Add a Contacts table linked to companies and investors.
3. Add outreach draft fields and templates, still without sending email.
4. Add richer CSV column mapping for messy Crunchbase exports.
5. Add duplicate detection and merge tools for companies and investors.
6. Add lightweight analytics: funding momentum, hiring signal, top sectors, and investor overlap.
7. Add optional local AI assistance for outreach angle generation after the core tracker is stable.
