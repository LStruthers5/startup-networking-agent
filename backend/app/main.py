from __future__ import annotations

import csv
import io
import re
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .database import get_connection, init_db, seed_if_empty
from .models import CompanyUpdate, InvestorUpdate

app = FastAPI(title="Startup Networking Tracker")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CSV_FIELDS = [
    "company_name",
    "sector",
    "description",
    "location",
    "website",
    "latest_funding_round",
    "funding_amount",
    "funding_date",
    "lead_investors",
    "other_investors",
    "employee_count",
    "crunchbase_url",
    "careers_url",
]

COMPANY_SELECT = """
    SELECT *,
        market_fit_score + personal_fit_score + hiring_fit_score + network_fit_score AS total_score
    FROM companies
"""


@app.on_event("startup")
def startup() -> None:
    init_db()
    seed_if_empty()


def row_to_dict(row: Any) -> dict[str, Any]:
    return dict(row)


def normalize_header(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "_", value.strip().lower())
    return cleaned.strip("_")


def split_investors(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[,;]", value or "") if item.strip()]


def ensure_investors(conn: Any, company_name: str, lead_investors: str, other_investors: str) -> None:
    investors = split_investors(lead_investors) + split_investors(other_investors)
    for investor_name in investors:
        existing = conn.execute(
            "SELECT id, portfolio_companies FROM investors WHERE lower(investor_name) = lower(?)",
            (investor_name,),
        ).fetchone()
        if existing:
            portfolio = [
                item.strip()
                for item in (existing["portfolio_companies"] or "").split(",")
                if item.strip()
            ]
            if company_name not in portfolio:
                portfolio.append(company_name)
                conn.execute(
                    """
                    UPDATE investors
                    SET portfolio_companies = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (", ".join(portfolio), existing["id"]),
                )
        else:
            conn.execute(
                """
                INSERT INTO investors (investor_name, portfolio_companies)
                VALUES (?, ?)
                """,
                (investor_name, company_name),
            )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/companies")
def list_companies(
    sector: str | None = None,
    location: str | None = None,
    status: str | None = None,
    min_score: int | None = None,
    funding_round: str | None = None,
    investor: str | None = None,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []

    if sector:
        clauses.append("sector = ?")
        params.append(sector)
    if location:
        clauses.append("location LIKE ?")
        params.append(f"%{location}%")
    if status:
        clauses.append("status = ?")
        params.append(status)
    if min_score:
        clauses.append(
            "(market_fit_score + personal_fit_score + hiring_fit_score + network_fit_score) >= ?"
        )
        params.append(min_score)
    if funding_round:
        clauses.append("latest_funding_round = ?")
        params.append(funding_round)
    if investor:
        clauses.append("(lead_investors LIKE ? OR other_investors LIKE ?)")
        params.extend([f"%{investor}%", f"%{investor}%"])

    query = COMPANY_SELECT
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY total_score DESC, funding_date DESC, company_name ASC"

    with get_connection() as conn:
        return [row_to_dict(row) for row in conn.execute(query, params).fetchall()]


@app.get("/api/companies/{company_id}")
def get_company(company_id: int) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute(COMPANY_SELECT + " WHERE id = ?", (company_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Company not found")
    return row_to_dict(row)


@app.patch("/api/companies/{company_id}")
def update_company(company_id: int, payload: CompanyUpdate) -> dict[str, Any]:
    with get_connection() as conn:
        exists = conn.execute("SELECT id FROM companies WHERE id = ?", (company_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Company not found")
        conn.execute(
            """
            UPDATE companies
            SET market_fit_score = ?, personal_fit_score = ?, hiring_fit_score = ?,
                network_fit_score = ?, status = ?, notes = ?, next_action = ?,
                outreach_angle = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                payload.market_fit_score,
                payload.personal_fit_score,
                payload.hiring_fit_score,
                payload.network_fit_score,
                payload.status,
                payload.notes,
                payload.next_action,
                payload.outreach_angle,
                company_id,
            ),
        )
        row = conn.execute(COMPANY_SELECT + " WHERE id = ?", (company_id,)).fetchone()
    return row_to_dict(row)


@app.post("/api/import/companies")
async def import_companies(file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a CSV file.")

    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="CSV must be UTF-8 encoded.") from exc

    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise HTTPException(status_code=400, detail="CSV is missing a header row.")

    header_map = {name: normalize_header(name) for name in reader.fieldnames}
    missing = ["company_name"] if "company_name" not in header_map.values() else []
    if missing:
        raise HTTPException(status_code=400, detail="CSV must include company_name.")

    imported = 0
    updated = 0
    skipped: list[dict[str, Any]] = []

    with get_connection() as conn:
        for index, raw_row in enumerate(reader, start=2):
            row = {header_map[key]: (value or "").strip() for key, value in raw_row.items() if key}
            company_name = row.get("company_name", "")
            if not company_name:
                skipped.append({"row": index, "reason": "Missing company_name"})
                continue

            values = {field: row.get(field, "") for field in CSV_FIELDS}
            existing = conn.execute(
                "SELECT id FROM companies WHERE lower(company_name) = lower(?)",
                (company_name,),
            ).fetchone()

            if existing:
                assignments = ", ".join([f"{field} = ?" for field in CSV_FIELDS if field != "company_name"])
                conn.execute(
                    f"""
                    UPDATE companies
                    SET {assignments}, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    [values[field] for field in CSV_FIELDS if field != "company_name"] + [existing["id"]],
                )
                updated += 1
            else:
                placeholders = ", ".join(["?"] * len(CSV_FIELDS))
                conn.execute(
                    f"""
                    INSERT INTO companies ({", ".join(CSV_FIELDS)})
                    VALUES ({placeholders})
                    """,
                    [values[field] for field in CSV_FIELDS],
                )
                imported += 1

            ensure_investors(conn, values["company_name"], values["lead_investors"], values["other_investors"])

    return {"imported": imported, "updated": updated, "skipped": skipped}


@app.get("/api/filter-options")
def filter_options() -> dict[str, list[str]]:
    with get_connection() as conn:
        sectors = conn.execute("SELECT DISTINCT sector FROM companies WHERE sector != '' ORDER BY sector").fetchall()
        statuses = conn.execute("SELECT DISTINCT status FROM companies WHERE status != '' ORDER BY status").fetchall()
        rounds = conn.execute(
            "SELECT DISTINCT latest_funding_round FROM companies WHERE latest_funding_round != '' ORDER BY latest_funding_round"
        ).fetchall()
        investors = conn.execute("SELECT investor_name FROM investors ORDER BY investor_name").fetchall()
    return {
        "sectors": [row[0] for row in sectors],
        "statuses": [row[0] for row in statuses],
        "funding_rounds": [row[0] for row in rounds],
        "investors": [row[0] for row in investors],
    }


@app.get("/api/investors")
def list_investors() -> list[dict[str, Any]]:
    with get_connection() as conn:
        return [
            row_to_dict(row)
            for row in conn.execute("SELECT * FROM investors ORDER BY priority_score DESC, investor_name ASC").fetchall()
        ]


@app.post("/api/investors")
def create_investor(payload: InvestorUpdate) -> dict[str, Any]:
    with get_connection() as conn:
        try:
            cursor = conn.execute(
                """
                INSERT INTO investors (
                    investor_name, thesis_tags, portfolio_companies, relevant_partner,
                    contact_path, priority_score, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload.investor_name,
                    payload.thesis_tags,
                    payload.portfolio_companies,
                    payload.relevant_partner,
                    payload.contact_path,
                    payload.priority_score,
                    payload.notes,
                ),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Investor name must be unique.") from exc
        row = conn.execute("SELECT * FROM investors WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.patch("/api/investors/{investor_id}")
def update_investor(investor_id: int, payload: InvestorUpdate) -> dict[str, Any]:
    with get_connection() as conn:
        exists = conn.execute("SELECT id FROM investors WHERE id = ?", (investor_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Investor not found")
        conn.execute(
            """
            UPDATE investors
            SET investor_name = ?, thesis_tags = ?, portfolio_companies = ?,
                relevant_partner = ?, contact_path = ?, priority_score = ?,
                notes = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                payload.investor_name,
                payload.thesis_tags,
                payload.portfolio_companies,
                payload.relevant_partner,
                payload.contact_path,
                payload.priority_score,
                payload.notes,
                investor_id,
            ),
        )
        row = conn.execute("SELECT * FROM investors WHERE id = ?", (investor_id,)).fetchone()
    return row_to_dict(row)
