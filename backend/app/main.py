from __future__ import annotations

import csv
import io
import json
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .agents import generate_company_networking_brief, generate_investor_mapping_brief
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

CRUNCHBASE_FIELD_MAPPING = {
    "Organization Name": "company_name",
    "Industries": "sector",
    "Description": "description",
    "Headquarters Location": "location",
    "Website": "website",
    "Last Funding Type": "latest_funding_round",
    "Last Funding Amount": "funding_amount",
    "Last Funding Date": "funding_date",
    "Total Funding Amount": "total_funding_amount",
    "Top 5 Investors": "other_investors",
    "Lead Investors": "lead_investors",
    "Number of Employees": "employee_count",
    "Crunchbase URL": "crunchbase_url",
    "LinkedIn": "linkedin_url",
    "Founders": "founders",
    "Founded Date": "founded_date",
    "Operating Status": "operating_status",
    "CB Rank (Company)": "cb_rank",
    "Number of Funding Rounds": "number_of_funding_rounds",
}

RECOMMENDED_CRUNCHBASE_COLUMNS = [
    "Organization Name",
    "Industries",
    "Description",
    "Headquarters Location",
    "Website",
    "Last Funding Type",
    "Last Funding Amount",
    "Last Funding Date",
    "Lead Investors",
    "Top 5 Investors",
    "Crunchbase URL",
]

IMPORT_COMPANY_FIELDS = [
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
    "linkedin_url",
    "founders",
    "founded_date",
    "operating_status",
    "cb_rank",
    "total_funding_amount",
    "number_of_funding_rounds",
    "data_source",
    "last_synced_at",
    "data_quality_score",
    "data_warnings",
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


def agent_run_to_dict(row: Any) -> dict[str, Any]:
    data = dict(row)
    data["input_snapshot"] = json.loads(data["input_snapshot"])
    data["output_json"] = json.loads(data["output_json"])
    return data


def normalize_header(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "_", value.strip().lower())
    return cleaned.strip("_")


def split_investors(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[,;]", value or "") if item.strip()]


def parse_investor_list(value: str) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for item in re.split(r"[,;|]", value or ""):
        name = item.strip()
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            names.append(name)
    return names


async def parse_uploaded_csv(file: UploadFile) -> tuple[list[str], list[dict[str, str]]]:
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

    detected_columns = [column.strip() for column in reader.fieldnames if column]
    rows = [
        {key.strip(): (value or "").strip() for key, value in raw_row.items() if key}
        for raw_row in reader
    ]
    return detected_columns, rows


def infer_crunchbase_field_mapping(detected_columns: list[str]) -> dict[str, str]:
    normalized_to_column = {normalize_header(column): column for column in detected_columns}
    proposed: dict[str, str] = {}
    for crunchbase_column, app_field in CRUNCHBASE_FIELD_MAPPING.items():
        detected = normalized_to_column.get(normalize_header(crunchbase_column))
        if detected:
            proposed[detected] = app_field
    return proposed


def normalize_crunchbase_row(row: dict[str, str], proposed_mapping: dict[str, str]) -> dict[str, Any]:
    company_data = {field: "" for field in IMPORT_COMPANY_FIELDS}
    for source_column, app_field in proposed_mapping.items():
        if app_field in company_data:
            company_data[app_field] = row.get(source_column, "").strip()
    company_data["data_source"] = "Crunchbase CSV"
    company_data["last_synced_at"] = datetime.now(timezone.utc).isoformat()
    company_data["data_quality_score"] = calculate_data_quality_score(company_data)
    company_data["data_warnings"] = json.dumps(identify_data_warnings(company_data))
    return company_data


def calculate_data_quality_score(company_data: dict[str, Any]) -> int:
    score = 0
    score += 1 if company_data.get("description") else 0
    score += 1 if company_data.get("website") else 0
    score += 1 if company_data.get("sector") else 0
    score += 1 if company_data.get("location") else 0
    score += 1 if (
        company_data.get("latest_funding_round")
        or company_data.get("funding_date")
        or company_data.get("funding_amount")
    ) else 0
    score += 1 if (company_data.get("lead_investors") or company_data.get("other_investors")) else 0
    score += 1 if company_data.get("crunchbase_url") else 0
    score += 1 if company_data.get("linkedin_url") else 0
    return score


def identify_data_warnings(company_data: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    if not company_data.get("description"):
        warnings.append("missing description")
    if not company_data.get("website"):
        warnings.append("missing website")
    if not (company_data.get("lead_investors") or company_data.get("other_investors")):
        warnings.append("missing investors")
    if not company_data.get("funding_date"):
        warnings.append("missing funding date")
    if not company_data.get("funding_amount"):
        warnings.append("missing funding amount")
    if not company_data.get("crunchbase_url"):
        warnings.append("missing Crunchbase URL")
    operating_status = (company_data.get("operating_status") or "").lower()
    if operating_status and operating_status != "active":
        warnings.append(f"inactive operating status: {company_data.get('operating_status')}")
    return warnings


def find_duplicate_csv_companies(company_names: list[str]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for name in company_names:
        key = name.lower()
        if key in seen:
            duplicates.add(name)
        elif key:
            seen.add(key)
    return sorted(duplicates)


def build_crunchbase_preview(
    conn: Any,
    detected_columns: list[str],
    rows: list[dict[str, str]],
) -> dict[str, Any]:
    proposed_mapping = infer_crunchbase_field_mapping(detected_columns)
    normalized_rows = [normalize_crunchbase_row(row, proposed_mapping) for row in rows]
    company_names = [row.get("company_name", "") for row in normalized_rows if row.get("company_name")]
    duplicate_csv_companies = find_duplicate_csv_companies(company_names)
    existing_companies = {
        row["company_name"].lower(): row["company_name"]
        for row in conn.execute("SELECT company_name FROM companies").fetchall()
    }
    existing_investors = {
        row["investor_name"].lower()
        for row in conn.execute("SELECT investor_name FROM investors").fetchall()
    }

    duplicate_existing_companies = sorted(
        {existing_companies[name.lower()] for name in company_names if name.lower() in existing_companies}
    )
    all_investors = set()
    for row in normalized_rows:
        all_investors.update(parse_investor_list(row.get("lead_investors", "")))
        all_investors.update(parse_investor_list(row.get("other_investors", "")))
    investors_to_create = sorted(
        investor for investor in all_investors if investor.lower() not in existing_investors
    )

    warnings: list[dict[str, Any]] = []
    for index, row in enumerate(normalized_rows, start=2):
        row_warnings = identify_data_warnings(row)
        if not row.get("company_name"):
            row_warnings.append("missing company name")
        if row.get("company_name") in duplicate_csv_companies:
            row_warnings.append("duplicate company name inside CSV")
        if row.get("company_name") in duplicate_existing_companies:
            row_warnings.append("company already exists and will be updated")
        if row_warnings:
            warnings.append(
                {
                    "row": index,
                    "company_name": row.get("company_name"),
                    "warnings": row_warnings,
                }
            )

    preview_rows = []
    for index, row in enumerate(normalized_rows[:10], start=2):
        row_preview = {
            key: row.get(key)
            for key in [
                "company_name",
                "sector",
                "location",
                "latest_funding_round",
                "funding_amount",
                "funding_date",
                "lead_investors",
                "other_investors",
                "data_quality_score",
            ]
        }
        row_preview["row_number"] = index
        row_preview["warnings"] = identify_data_warnings(row)
        preview_rows.append(row_preview)

    return {
        "detected_columns": detected_columns,
        "proposed_field_mapping": proposed_mapping,
        "row_count": len(rows),
        "preview_rows": preview_rows,
        "missing_recommended_columns": [
            column
            for column in RECOMMENDED_CRUNCHBASE_COLUMNS
            if normalize_header(column) not in {normalize_header(detected) for detected in detected_columns}
        ],
        "duplicate_existing_companies": duplicate_existing_companies,
        "duplicate_csv_companies": duplicate_csv_companies,
        "investors_to_create": investors_to_create,
        "warnings": warnings,
    }


def upsert_company_from_import(conn: Any, company_data: dict[str, Any]) -> str:
    existing = conn.execute(
        "SELECT id FROM companies WHERE lower(company_name) = lower(?)",
        (company_data["company_name"],),
    ).fetchone()
    if existing:
        assignments = ", ".join([f"{field} = ?" for field in IMPORT_COMPANY_FIELDS if field != "company_name"])
        conn.execute(
            f"""
            UPDATE companies
            SET {assignments}, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            [company_data[field] for field in IMPORT_COMPANY_FIELDS if field != "company_name"] + [existing["id"]],
        )
        return "updated"

    placeholders = ", ".join(["?"] * len(IMPORT_COMPANY_FIELDS))
    conn.execute(
        f"""
        INSERT INTO companies ({", ".join(IMPORT_COMPANY_FIELDS)})
        VALUES ({placeholders})
        """,
        [company_data[field] for field in IMPORT_COMPANY_FIELDS],
    )
    return "created"


def upsert_investors_from_company(conn: Any, company_data: dict[str, Any]) -> dict[str, int]:
    created = 0
    updated = 0
    investors = parse_investor_list(company_data.get("lead_investors", "")) + parse_investor_list(
        company_data.get("other_investors", "")
    )
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
            if company_data["company_name"] not in portfolio:
                portfolio.append(company_data["company_name"])
                conn.execute(
                    """
                    UPDATE investors
                    SET portfolio_companies = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (", ".join(portfolio), existing["id"]),
                )
            updated += 1
        else:
            conn.execute(
                """
                INSERT INTO investors (investor_name, portfolio_companies, notes)
                VALUES (?, ?, ?)
                """,
                (
                    investor_name,
                    company_data["company_name"],
                    "Created from Crunchbase CSV import.",
                ),
            )
            created += 1
    return {"created": created, "updated": updated}


def load_linked_investors(conn: Any, investor_names: list[str]) -> list[dict[str, Any]]:
    linked_investors: list[dict[str, Any]] = []
    for investor_name in investor_names:
        row = conn.execute(
            """
            SELECT investor_name, thesis_tags, portfolio_companies, relevant_partner,
                contact_path, priority_score, notes
            FROM investors
            WHERE lower(investor_name) = lower(?)
            """,
            (investor_name,),
        ).fetchone()
        if row:
            investor = row_to_dict(row)
            investor.setdefault("next_action", "")
            investor.setdefault("status", "")
            linked_investors.append(investor)
    return linked_investors


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


@app.post("/imports/crunchbase/preview")
async def preview_crunchbase_import(file: UploadFile = File(...)) -> dict[str, Any]:
    detected_columns, rows = await parse_uploaded_csv(file)
    with get_connection() as conn:
        return build_crunchbase_preview(conn, detected_columns, rows)


@app.post("/imports/crunchbase/confirm")
async def confirm_crunchbase_import(
    file: UploadFile = File(...),
    confirm: bool = Form(True),
) -> dict[str, Any]:
    detected_columns, rows = await parse_uploaded_csv(file)
    proposed_mapping = infer_crunchbase_field_mapping(detected_columns)
    summary = {
        "companies_created": 0,
        "companies_updated": 0,
        "investors_created": 0,
        "investors_updated": 0,
        "rows_skipped": 0,
        "warnings": [],
    }

    if not confirm:
        summary["warnings"].append({"row": None, "warnings": ["confirm flag was false; no rows imported"]})
        return summary

    company_names = [
        normalize_crunchbase_row(row, proposed_mapping).get("company_name", "")
        for row in rows
    ]
    duplicate_csv_companies = set(find_duplicate_csv_companies([name for name in company_names if name]))

    with get_connection() as conn:
        for index, raw_row in enumerate(rows, start=2):
            company_data = normalize_crunchbase_row(raw_row, proposed_mapping)
            row_warnings = identify_data_warnings(company_data)
            if not company_data.get("company_name"):
                summary["rows_skipped"] += 1
                summary["warnings"].append(
                    {"row": index, "company_name": "", "warnings": ["missing company name; row skipped"]}
                )
                continue
            if company_data["company_name"] in duplicate_csv_companies:
                row_warnings.append("duplicate company name inside CSV")
            company_data["data_warnings"] = json.dumps(row_warnings)

            result = upsert_company_from_import(conn, company_data)
            if result == "created":
                summary["companies_created"] += 1
            else:
                summary["companies_updated"] += 1

            investor_counts = upsert_investors_from_company(conn, company_data)
            summary["investors_created"] += investor_counts["created"]
            summary["investors_updated"] += investor_counts["updated"]

            if row_warnings:
                summary["warnings"].append(
                    {
                        "row": index,
                        "company_name": company_data["company_name"],
                        "warnings": row_warnings,
                    }
                )

    return summary


@app.post("/agents/company-brief/{company_id}")
def create_company_brief(company_id: int) -> dict[str, Any]:
    with get_connection() as conn:
        company = conn.execute(COMPANY_SELECT + " WHERE id = ?", (company_id,)).fetchone()
        if company is None:
            raise HTTPException(status_code=404, detail="Company not found")

        input_snapshot = row_to_dict(company)
        output_json = generate_company_networking_brief(input_snapshot)
        cursor = conn.execute(
            """
            INSERT INTO agent_runs (
                agent_type, target_type, target_id, input_snapshot, output_json, status
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "company_networking_brief",
                "company",
                company_id,
                json.dumps(input_snapshot),
                json.dumps(output_json),
                "completed",
            ),
        )
        row = conn.execute("SELECT * FROM agent_runs WHERE id = ?", (cursor.lastrowid,)).fetchone()

    return agent_run_to_dict(row)


@app.get("/agents/company-brief/{company_id}/runs")
def list_company_brief_runs(company_id: int) -> list[dict[str, Any]]:
    with get_connection() as conn:
        exists = conn.execute("SELECT id FROM companies WHERE id = ?", (company_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Company not found")
        rows = conn.execute(
            """
            SELECT *
            FROM agent_runs
            WHERE agent_type = ? AND target_type = ? AND target_id = ?
            ORDER BY created_at DESC, id DESC
            """,
            ("company_networking_brief", "company", company_id),
        ).fetchall()

    return [agent_run_to_dict(row) for row in rows]


@app.post("/agents/investor-map/company/{company_id}")
def create_investor_map(company_id: int) -> dict[str, Any]:
    with get_connection() as conn:
        company = conn.execute(COMPANY_SELECT + " WHERE id = ?", (company_id,)).fetchone()
        if company is None:
            raise HTTPException(status_code=404, detail="Company not found")

        company_snapshot = row_to_dict(company)
        investor_names = split_investors(company_snapshot.get("lead_investors") or "") + split_investors(
            company_snapshot.get("other_investors") or ""
        )
        linked_investors = load_linked_investors(conn, investor_names)
        input_snapshot = {
            "company": company_snapshot,
            "linked_investors": linked_investors,
        }
        output_json = generate_investor_mapping_brief(company_snapshot, linked_investors)
        cursor = conn.execute(
            """
            INSERT INTO agent_runs (
                agent_type, target_type, target_id, input_snapshot, output_json, status
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "investor_mapping_brief",
                "company",
                company_id,
                json.dumps(input_snapshot),
                json.dumps(output_json),
                "completed",
            ),
        )
        row = conn.execute("SELECT * FROM agent_runs WHERE id = ?", (cursor.lastrowid,)).fetchone()

    return agent_run_to_dict(row)


@app.get("/agents/investor-map/company/{company_id}/runs")
def list_investor_map_runs(company_id: int) -> list[dict[str, Any]]:
    with get_connection() as conn:
        exists = conn.execute("SELECT id FROM companies WHERE id = ?", (company_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Company not found")
        rows = conn.execute(
            """
            SELECT *
            FROM agent_runs
            WHERE agent_type = ? AND target_type = ? AND target_id = ?
            ORDER BY created_at DESC, id DESC
            """,
            ("investor_mapping_brief", "company", company_id),
        ).fetchall()

    return [agent_run_to_dict(row) for row in rows]


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
