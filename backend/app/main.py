from __future__ import annotations

import csv
import io
import inspect
import json
import logging
import re
import time
from datetime import datetime, timezone
from functools import wraps
from typing import Any
from urllib.parse import quote_plus

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .agents import generate_company_networking_brief, generate_investor_mapping_brief
from .database import DB_PATH, get_connection, init_db, seed_if_empty
from .models import ActionUpdate, CompanyUpdate, InvestorUpdate

app = FastAPI(title="Startup Networking Tracker")
logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
logger = logging.getLogger("startup_networking_tracker")
logger.setLevel(logging.INFO)
BACKEND_START_TIME = datetime.now(timezone.utc).isoformat()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
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

INVESTOR_PROFILE_FIELDS = [
    "investor_name",
    "display_name",
    "canonical_name",
    "aliases",
    "dedupe_review_needed",
    "investor_type",
    "thesis_tags",
    "stage_focus",
    "sector_focus",
    "location",
    "website",
    "linkedin_url",
    "crunchbase_url",
    "portfolio_companies",
    "tracked_company_count",
    "lead_investment_count",
    "co_investment_count",
    "high_fit_company_count",
    "average_company_fit_score",
    "top_tracked_companies",
    "sectors_from_portfolio",
    "stages_from_portfolio",
    "last_seen_funding_date",
    "portfolio_overlap_summary",
    "relevant_partner",
    "partner_linkedin_url",
    "talent_or_platform_contact",
    "contact_path",
    "relationship_strength",
    "enrichment_status",
    "recommended_research_task",
    "next_action",
    "priority_score",
    "notes",
    "data_source",
    "last_enriched_at",
    "enrichment_warnings",
    "missing_fields",
]

MANUAL_INVESTOR_FIELDS = {
    "notes",
    "relevant_partner",
    "contact_path",
    "relationship_strength",
    "partner_linkedin_url",
    "talent_or_platform_contact",
}

TARGET_INVESTOR_SECTORS = {
    "wearables",
    "fitness",
    "sports tech",
    "sports",
    "digital health",
    "ai health",
    "health",
    "smb software",
    "fintech",
    "finance ops",
    "finance",
    "operations software",
    "operations",
}

OPEN_ACTION_STATUSES = {"New", "Planned", "In Progress", "Waiting"}
OUTREACH_UNBLOCKING_ACTIONS = {
    "Find Partner",
    "Find Contact Path",
    "Check Hiring",
    "Draft Outreach",
    "Send Outreach",
    "Review Missing Data",
}

COMPANY_SELECT = """
    SELECT *,
        market_fit_score + personal_fit_score + hiring_fit_score + network_fit_score AS total_score
    FROM companies
"""

COMPANY_LIST_SELECT = """
    SELECT
        id,
        company_name,
        sector,
        location,
        latest_funding_round,
        funding_amount,
        funding_date,
        lead_investors,
        other_investors,
        status,
        market_fit_score,
        personal_fit_score,
        hiring_fit_score,
        network_fit_score,
        market_fit_score + personal_fit_score + hiring_fit_score + network_fit_score AS total_score,
        data_source,
        data_quality_score,
        (
            SELECT COUNT(*)
            FROM action_items
            WHERE action_items.target_type = 'Company'
                AND action_items.target_id = companies.id
                AND action_items.status NOT IN ('Done', 'Skipped')
        ) AS open_action_count
    FROM companies
"""


@app.on_event("startup")
def startup() -> None:
    init_db()
    seed_if_empty()


def timed_endpoint(name: str):
    def decorator(func):
        if inspect.iscoroutinefunction(func):
            @wraps(func)
            async def async_wrapper(*args, **kwargs):
                start = time.perf_counter()
                try:
                    return await func(*args, **kwargs)
                finally:
                    elapsed_ms = (time.perf_counter() - start) * 1000
                    logger.info("%s completed in %.1fms", name, elapsed_ms)

            return async_wrapper

        @wraps(func)
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            try:
                return func(*args, **kwargs)
            finally:
                elapsed_ms = (time.perf_counter() - start) * 1000
                logger.info("%s completed in %.1fms", name, elapsed_ms)

        return wrapper

    return decorator


def row_to_dict(row: Any) -> dict[str, Any]:
    return dict(row)


def agent_run_to_dict(row: Any) -> dict[str, Any]:
    data = dict(row)
    data["input_snapshot"] = json.loads(data["input_snapshot"])
    data["output_json"] = json.loads(data["output_json"])
    return data


def investor_row_to_dict(row: Any) -> dict[str, Any]:
    data = dict(row)
    data["missing_fields"] = parse_json_list(data.get("missing_fields") or "")
    data["enrichment_warnings"] = parse_json_list(data.get("enrichment_warnings") or "")
    data["research_links"] = build_research_links(data)
    data["recommended_research_task"] = recommend_research_task_from_investor_row(
        data,
        data["missing_fields"],
    )
    return data


def action_row_to_dict(row: Any) -> dict[str, Any]:
    data = dict(row)
    data["research_links"] = parse_json_dict(data.get("research_links") or "")
    return data


def normalize_header(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "_", value.strip().lower())
    return cleaned.strip("_")


def split_investors(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[,;]", value or "") if item.strip()]


def parse_investor_list(value: str) -> list[str]:
    raw_parts = [item.strip() for item in re.split(r"[,;|]", value or "") if item.strip()]
    parts: list[str] = []
    suffix_pattern = re.compile(r"^(llc|l\.?p\.?|inc\.?|co\.?)$", re.IGNORECASE)
    for part in raw_parts:
        if parts and suffix_pattern.match(part.replace(",", "").strip(".")):
            parts[-1] = f"{parts[-1]}, {part}"
        else:
            parts.append(part)

    names: list[str] = []
    seen: set[str] = set()
    for item in parts:
        name = clean_display_name(item)
        key = name.lower()
        if name and key not in seen:
            seen.add(key)
            names.append(name)
    return names


def clean_display_name(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", (value or "").strip())
    cleaned = re.sub(r",\s*,+", ",", cleaned)
    cleaned = re.sub(r"\s+,", ",", cleaned)
    cleaned = re.sub(r",\s*", ", ", cleaned)
    if cleaned.isupper() and len(cleaned) > 3:
        cleaned = cleaned.title()
    return cleaned.strip(" ,")


def canonicalize_investor_name(value: str) -> dict[str, Any]:
    display_name = clean_display_name(value)
    canonical = display_name
    suffixes = [
        r",?\s+L\.?L\.?C\.?$",
        r",?\s+L\.?P\.?$",
        r",?\s+Inc\.?$",
        r",?\s+Co\.?$",
        r",?\s+Company$",
    ]
    for suffix in suffixes:
        canonical = re.sub(suffix, "", canonical, flags=re.IGNORECASE).strip(" ,")
    if canonical.isupper() and len(canonical) > 3:
        canonical = canonical.title()
    review_needed = bool(display_name and canonical and display_name.lower() != canonical.lower())
    return {
        "display_name": display_name,
        "canonical_name": canonical or display_name,
        "dedupe_review_needed": review_needed,
    }


def canonical_key(value: str) -> str:
    canonical = canonicalize_investor_name(value)["canonical_name"]
    return re.sub(r"[^a-z0-9]+", "", canonical.lower())


def split_tags(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"[,;|]", value or "") if item.strip()]


def dedupe_preserve(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        cleaned = item.strip()
        key = cleaned.lower()
        if cleaned and key not in seen:
            seen.add(key)
            result.append(cleaned)
    return result


def join_top(items: list[str], limit: int = 8) -> str:
    return ", ".join(dedupe_preserve(items)[:limit])


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
            SELECT *
            FROM investors
            WHERE lower(investor_name) = lower(?)
                OR lower(canonical_name) = lower(?)
            """,
            (investor_name, canonicalize_investor_name(investor_name)["canonical_name"]),
        ).fetchone()
        if row:
            investor = row_to_dict(row)
            investor.setdefault("next_action", "")
            investor.setdefault("status", "")
            investor["missing_fields"] = parse_json_list(investor.get("missing_fields") or "")
            investor["enrichment_warnings"] = parse_json_list(investor.get("enrichment_warnings") or "")
            linked_investors.append(investor)
    return linked_investors


def ensure_investors(conn: Any, company_name: str, lead_investors: str, other_investors: str) -> None:
    investors = parse_investor_list(lead_investors) + parse_investor_list(other_investors)
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


def rebuild_investor_profiles_from_companies(conn: Any) -> dict[str, Any]:
    companies = [row_to_dict(row) for row in conn.execute(COMPANY_SELECT).fetchall()]
    existing_rows = [row_to_dict(row) for row in conn.execute("SELECT * FROM investors").fetchall()]
    existing_by_key: dict[str, dict[str, Any]] = {}
    existing_key_counts: dict[str, list[str]] = {}
    for investor in existing_rows:
        key = canonical_key(investor.get("canonical_name") or investor.get("investor_name") or "")
        existing_key_counts.setdefault(key, []).append(investor.get("investor_name") or "")
        if key and key not in existing_by_key:
            existing_by_key[key] = investor

    profiles: dict[str, dict[str, Any]] = {}
    for company in companies:
        lead_names = parse_investor_list(company.get("lead_investors") or "")
        other_names = parse_investor_list(company.get("other_investors") or "")
        lead_keys = {canonical_key(name) for name in lead_names}
        for investor_name in lead_names:
            add_company_to_investor_profile(profiles, investor_name, company, is_lead=True)
        for investor_name in other_names:
            add_company_to_investor_profile(
                profiles,
                investor_name,
                company,
                is_lead=canonical_key(investor_name) in lead_keys,
                is_other=True,
            )

    created = 0
    updated = 0
    possible_duplicates = [
        {"canonical_name": names[0], "aliases": sorted(dedupe_preserve(names))}
        for names in existing_key_counts.values()
        if len(dedupe_preserve(names)) > 1
    ]

    now = datetime.now(timezone.utc).isoformat()
    for key, profile in profiles.items():
        existing = existing_by_key.get(key)
        duplicate_aliases = existing_key_counts.get(key, [])
        if duplicate_aliases and len(dedupe_preserve(duplicate_aliases + list(profile["aliases"]))) > 1:
            profile["dedupe_review_needed"] = True
            possible_duplicates.append(
                {
                    "canonical_name": profile["canonical_name"],
                    "aliases": sorted(dedupe_preserve(duplicate_aliases + list(profile["aliases"]))),
                }
            )
        profile_data = build_investor_profile_data(profile, existing, now)
        if existing:
            update_investor_profile(conn, existing["id"], profile_data, existing)
            updated += 1
        else:
            insert_investor_profile(conn, profile_data)
            created += 1

    queue_rows = build_enrichment_queue_rows(conn)
    return {
        "investors_created": created,
        "investors_updated": updated,
        "possible_duplicates": dedupe_duplicate_payloads(possible_duplicates),
        "investors_needing_research": len(
            [row for row in queue_rows if row.get("enrichment_status") in {"New", "Needs Research", "Partially Enriched"}]
        ),
        "top_priority_investors": queue_rows[:10],
    }


def add_company_to_investor_profile(
    profiles: dict[str, dict[str, Any]],
    investor_name: str,
    company: dict[str, Any],
    is_lead: bool = False,
    is_other: bool = False,
) -> None:
    canonical = canonicalize_investor_name(investor_name)
    key = canonical_key(investor_name)
    if not key:
        return
    profile = profiles.setdefault(
        key,
        {
            "investor_name": canonical["display_name"],
            "display_name": canonical["display_name"],
            "canonical_name": canonical["canonical_name"],
            "aliases": set(),
            "dedupe_review_needed": canonical["dedupe_review_needed"],
            "companies": {},
            "lead_companies": set(),
            "co_companies": set(),
            "sectors": [],
            "stages": [],
            "funding_dates": [],
            "scores": [],
            "high_fit_companies": set(),
        },
    )
    profile["aliases"].add(canonical["display_name"])
    profile["dedupe_review_needed"] = profile["dedupe_review_needed"] or canonical["dedupe_review_needed"]
    company_name = company.get("company_name") or ""
    if company_name:
        profile["companies"][company_name] = company
    if is_lead:
        profile["lead_companies"].add(company_name)
    elif is_other:
        profile["co_companies"].add(company_name)
    sector = company.get("sector") or ""
    if sector:
        profile["sectors"].extend(split_tags(sector))
    stage = company.get("latest_funding_round") or ""
    if stage:
        profile["stages"].append(stage)
    funding_date = company.get("funding_date") or ""
    if funding_date:
        profile["funding_dates"].append(funding_date)
    score = int(company.get("total_score") or 0)
    profile["scores"].append(score)
    if score >= 16 and company_name:
        profile["high_fit_companies"].add(company_name)


def build_investor_profile_data(
    profile: dict[str, Any],
    existing: dict[str, Any] | None,
    now: str,
) -> dict[str, Any]:
    companies = list(profile["companies"].values())
    company_names = sorted(profile["companies"].keys())
    lead_names = sorted(name for name in profile["lead_companies"] if name)
    co_names = sorted(name for name in profile["co_companies"] if name and name not in profile["lead_companies"])
    sectors = dedupe_preserve(profile["sectors"])
    stages = dedupe_preserve(profile["stages"])
    average_score = round(sum(profile["scores"]) / len(profile["scores"]), 1) if profile["scores"] else 0
    high_fit_count = len(profile["high_fit_companies"])
    missing_fields = identify_investor_missing_fields(existing, profile)
    warnings = build_investor_enrichment_warnings(profile, missing_fields)
    priority = calculate_investor_priority_score(profile, existing, missing_fields)
    recommended_task = recommend_investor_research_task(profile, existing, missing_fields)
    current_status = (existing or {}).get("enrichment_status") or "New"
    derived_status = infer_enrichment_status(existing, missing_fields)
    enrichment_status = current_status if current_status not in {"", "New"} else derived_status
    existing_thesis = (existing or {}).get("thesis_tags") or ""
    sector_focus = join_top(sectors, 10)
    stage_focus = join_top(stages, 8)
    top_companies = sorted(
        company_names,
        key=lambda name: int(profile["companies"][name].get("total_score") or 0),
        reverse=True,
    )[:8]

    data = {
        "investor_name": (existing or {}).get("investor_name") or profile["display_name"],
        "display_name": (existing or {}).get("display_name") or profile["display_name"],
        "canonical_name": profile["canonical_name"],
        "aliases": join_top(sorted(profile["aliases"]), 12),
        "dedupe_review_needed": 1 if profile["dedupe_review_needed"] else 0,
        "investor_type": (existing or {}).get("investor_type") or "Investor",
        "thesis_tags": existing_thesis or sector_focus,
        "stage_focus": stage_focus,
        "sector_focus": sector_focus,
        "location": (existing or {}).get("location") or "",
        "website": (existing or {}).get("website") or "",
        "linkedin_url": (existing or {}).get("linkedin_url") or "",
        "crunchbase_url": (existing or {}).get("crunchbase_url") or "",
        "portfolio_companies": ", ".join(company_names),
        "tracked_company_count": len(company_names),
        "lead_investment_count": len(lead_names),
        "co_investment_count": len(co_names),
        "high_fit_company_count": high_fit_count,
        "average_company_fit_score": average_score,
        "top_tracked_companies": ", ".join(top_companies),
        "sectors_from_portfolio": sector_focus,
        "stages_from_portfolio": stage_focus,
        "last_seen_funding_date": max(profile["funding_dates"]) if profile["funding_dates"] else "",
        "portfolio_overlap_summary": build_portfolio_overlap_summary(profile, sectors, stages),
        "relevant_partner": (existing or {}).get("relevant_partner") or "",
        "partner_linkedin_url": (existing or {}).get("partner_linkedin_url") or "",
        "talent_or_platform_contact": (existing or {}).get("talent_or_platform_contact") or "",
        "contact_path": (existing or {}).get("contact_path") or "",
        "relationship_strength": (existing or {}).get("relationship_strength") or "Unknown",
        "enrichment_status": enrichment_status,
        "recommended_research_task": recommended_task,
        "next_action": (existing or {}).get("next_action") or recommended_task,
        "priority_score": priority,
        "notes": (existing or {}).get("notes") or "",
        "data_source": "Derived from local company data",
        "last_enriched_at": now,
        "enrichment_warnings": json.dumps(warnings),
        "missing_fields": json.dumps(missing_fields),
    }
    return data


def identify_investor_missing_fields(
    existing: dict[str, Any] | None,
    profile: dict[str, Any],
) -> list[str]:
    existing = existing or {}
    missing = []
    checks = {
        "website": "firm website",
        "linkedin_url": "LinkedIn URL",
        "crunchbase_url": "Crunchbase URL",
        "relevant_partner": "relevant partner",
        "partner_linkedin_url": "partner LinkedIn URL",
        "contact_path": "contact path",
        "talent_or_platform_contact": "talent/platform contact",
    }
    for field, label in checks.items():
        if not existing.get(field):
            missing.append(label)
    if not existing.get("relationship_strength") or existing.get("relationship_strength") == "Unknown":
        missing.append("relationship strength")
    if not profile.get("lead_companies"):
        missing.append("lead investment evidence")
    return missing


def build_investor_enrichment_warnings(profile: dict[str, Any], missing_fields: list[str]) -> list[str]:
    warnings = []
    if profile.get("dedupe_review_needed"):
        warnings.append("possible duplicate or suffix-normalized investor name; review before merging")
    if "relevant partner" in missing_fields:
        warnings.append("missing partner mapping")
    if "contact path" in missing_fields:
        warnings.append("missing warm contact path")
    if "firm website" in missing_fields and "LinkedIn URL" in missing_fields and "Crunchbase URL" in missing_fields:
        warnings.append("missing firm research links")
    return warnings


def calculate_investor_priority_score(
    profile: dict[str, Any],
    existing: dict[str, Any] | None,
    missing_fields: list[str],
) -> int:
    existing = existing or {}
    score = 0
    if profile["lead_companies"]:
        score += 20
    score += min(len(profile["high_fit_companies"]) * 10, 30)
    if len(profile["companies"]) >= 2:
        score += 10
    sector_text = " ".join(profile["sectors"]).lower()
    if any(target in sector_text for target in TARGET_INVESTOR_SECTORS):
        score += 10
    stage_text = " ".join(profile["stages"]).lower()
    if any(stage in stage_text for stage in ["seed", "series a", "series b"]):
        score += 10
    if existing.get("contact_path"):
        score += 10
    if existing.get("relevant_partner"):
        score += 10
    if not (existing.get("website") or existing.get("linkedin_url") or existing.get("crunchbase_url")):
        score -= 10
    if not existing.get("contact_path") and existing.get("relationship_strength", "Unknown") == "Unknown":
        score -= 10
    return max(0, min(score, 100))


def recommend_investor_research_task(
    profile: dict[str, Any],
    existing: dict[str, Any] | None,
    missing_fields: list[str],
) -> str:
    existing = existing or {}
    lead_company = sorted(profile["lead_companies"])[0] if profile["lead_companies"] else ""
    top_company = next(iter(profile["companies"].keys()), "")
    if "relevant partner" in missing_fields and lead_company:
        return f"Find the partner who led the {lead_company} investment."
    if "firm website" in missing_fields or "LinkedIn URL" in missing_fields:
        return "Find firm website and LinkedIn page."
    if "talent/platform contact" in missing_fields:
        return "Check whether this investor has a talent/platform contact."
    if profile["sectors"]:
        return f"Look for portfolio companies similar to {join_top(profile['sectors'], 3)}."
    if "contact path" in missing_fields:
        return "Find a warm intro path through alumni, advisor, CCV, or LinkedIn."
    if top_company:
        return f"Research how this investor supports {top_company} and adjacent portfolio companies."
    return "Review investor profile and add relationship context."


def infer_enrichment_status(existing: dict[str, Any] | None, missing_fields: list[str]) -> str:
    existing = existing or {}
    if existing.get("contact_path") and existing.get("relevant_partner"):
        return "Ready for Outreach"
    if existing.get("contact_path"):
        return "Contact Path Found"
    if len(missing_fields) <= 3:
        return "Partially Enriched"
    return "Needs Research"


def build_portfolio_overlap_summary(profile: dict[str, Any], sectors: list[str], stages: list[str]) -> str:
    count = len(profile["companies"])
    lead_count = len(profile["lead_companies"])
    sector_text = join_top(sectors, 4) or "unknown sectors"
    stage_text = join_top(stages, 3) or "unknown stages"
    return (
        f"Backs {count} tracked compan{'y' if count == 1 else 'ies'}, including "
        f"{lead_count} lead investment{'s' if lead_count != 1 else ''}, across {sector_text} and {stage_text}."
    )


def insert_investor_profile(conn: Any, profile_data: dict[str, Any]) -> None:
    placeholders = ", ".join(["?"] * len(INVESTOR_PROFILE_FIELDS))
    conn.execute(
        f"""
        INSERT INTO investors ({", ".join(INVESTOR_PROFILE_FIELDS)})
        VALUES ({placeholders})
        """,
        [profile_data[field] for field in INVESTOR_PROFILE_FIELDS],
    )


def update_investor_profile(
    conn: Any,
    investor_id: int,
    profile_data: dict[str, Any],
    existing: dict[str, Any],
) -> None:
    update_data = profile_data.copy()
    for field in MANUAL_INVESTOR_FIELDS:
        update_data[field] = existing.get(field) or profile_data[field]
    assignments = ", ".join([f"{field} = ?" for field in INVESTOR_PROFILE_FIELDS if field != "investor_name"])
    conn.execute(
        f"""
        UPDATE investors
        SET {assignments}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        [update_data[field] for field in INVESTOR_PROFILE_FIELDS if field != "investor_name"] + [investor_id],
    )


def dedupe_duplicate_payloads(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in items:
        key = "|".join(item.get("aliases", []))
        if key and key not in seen:
            seen.add(key)
            result.append(item)
    return result


def parse_json_list(value: str) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return split_tags(value)
    if isinstance(parsed, list):
        return [str(item) for item in parsed]
    return [str(parsed)]


def parse_json_dict(value: str) -> dict[str, str]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except Exception:
        return {}
    if isinstance(parsed, dict):
        return {str(key): str(val) for key, val in parsed.items()}
    return {}


def build_research_links(investor: dict[str, Any]) -> dict[str, str]:
    name = investor.get("investor_name") or ""
    top_company = split_tags(investor.get("top_tracked_companies") or "")[:1]
    company = top_company[0] if top_company else ""
    sector = split_tags(investor.get("sector_focus") or "")[:1]
    sector_name = sector[0] if sector else "startup"
    links = {
        "Google": f"https://www.google.com/search?q={quote_plus(name)}",
        "LinkedIn Search": f"https://www.linkedin.com/search/results/all/?keywords={quote_plus(name)}",
        "Crunchbase Search": f"https://www.crunchbase.com/discover/organization.companies/field/organizations/name/{quote_plus(name)}",
        "Portfolio Search": f"https://www.google.com/search?q={quote_plus(name + ' portfolio')}",
        "Partner + Sector": f"https://www.google.com/search?q={quote_plus(name + ' partner ' + sector_name)}",
    }
    if company:
        links["Funding Round Search"] = f"https://www.google.com/search?q={quote_plus(name + ' ' + company + ' funding')}"
    if investor.get("website"):
        links["Firm Website"] = investor["website"]
    return links


def build_enrichment_queue_rows(conn: Any) -> list[dict[str, Any]]:
    rows = [
        row_to_dict(row)
        for row in conn.execute(
            """
            SELECT *
            FROM investors
            ORDER BY priority_score DESC, tracked_company_count DESC, investor_name ASC
            """
        ).fetchall()
    ]
    queue = []
    for row in rows:
        missing_fields = parse_json_list(row.get("missing_fields") or "")
        row["missing_fields"] = missing_fields
        row["enrichment_warnings"] = parse_json_list(row.get("enrichment_warnings") or "")
        row["recommended_research_task"] = recommend_research_task_from_investor_row(row, missing_fields)
        row["research_links"] = build_research_links(row)
        queue.append(row)
    queue.sort(key=lambda item: (int(item.get("priority_score") or 0), len(item.get("missing_fields") or [])), reverse=True)
    return queue


def recommend_research_task_from_investor_row(
    investor: dict[str, Any],
    missing_fields: list[str],
) -> str:
    lead_company = split_tags(investor.get("top_tracked_companies") or "")[:1]
    if "relevant partner" in missing_fields and lead_company:
        return f"Find the partner who led the {lead_company[0]} investment."
    if "firm website" in missing_fields or "LinkedIn URL" in missing_fields:
        return "Find firm website and LinkedIn page."
    if "talent/platform contact" in missing_fields:
        return "Check whether this investor has a talent/platform contact."
    if "contact path" in missing_fields:
        return "Find a warm intro path through alumni, advisor, CCV, or LinkedIn."
    if investor.get("sector_focus"):
        return f"Look for portfolio companies similar to {investor['sector_focus']}."
    return investor.get("next_action") or "Review investor profile and add relationship context."


def latest_agent_outputs(conn: Any, agent_type: str) -> dict[int, dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT target_id, output_json, created_at, id
        FROM agent_runs
        WHERE agent_type = ? AND target_type = ?
        ORDER BY target_id ASC, created_at DESC, id DESC
        """,
        (agent_type, "company"),
    ).fetchall()
    latest: dict[int, dict[str, Any]] = {}
    for row in rows:
        if row["target_id"] in latest:
            continue
        try:
            output = json.loads(row["output_json"])
        except Exception:
            output = {}
        latest[row["target_id"]] = output
    return latest


def generate_weekly_action_queue(conn: Any) -> dict[str, Any]:
    companies = [row_to_dict(row) for row in conn.execute(COMPANY_SELECT).fetchall()]
    investors = [row_to_dict(row) for row in conn.execute("SELECT * FROM investors").fetchall()]
    company_briefs = latest_agent_outputs(conn, "company_networking_brief")
    investor_maps = latest_agent_outputs(conn, "investor_mapping_brief")
    created = 0
    updated = 0
    skipped = 0

    for company in companies:
        for action in build_company_actions(company, company_briefs, investor_maps):
            result = upsert_action_item(conn, action)
            created += 1 if result == "created" else 0
            updated += 1 if result == "updated" else 0
            skipped += 1 if result == "skipped" else 0

    for investor in investors:
        for action in build_investor_actions(investor):
            result = upsert_action_item(conn, action)
            created += 1 if result == "created" else 0
            updated += 1 if result == "updated" else 0
            skipped += 1 if result == "skipped" else 0

    top_actions = list_actions_query(conn, status=None, action_type=None, target_type=None, min_priority=None, source=None, weekly=True)[:10]
    return {
        "actions_created": created,
        "actions_updated": updated,
        "actions_skipped": skipped,
        "top_actions": top_actions,
    }


def build_company_actions(
    company: dict[str, Any],
    company_briefs: dict[int, dict[str, Any]],
    investor_maps: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    actions = []
    company_id = int(company.get("id") or 0)
    total_score = int(company.get("total_score") or 0)
    has_investors = bool(company.get("lead_investors") or company.get("other_investors"))
    high_fit = total_score >= 16
    base = {
        "target_type": "Company",
        "target_id": company_id,
        "target_name": company.get("company_name") or "",
        "research_links": build_company_research_links(company),
    }

    if high_fit and company_id not in company_briefs:
        actions.append(make_action(base, "Run Company Brief Agent", "High-fit company does not have a Company Networking Brief yet.", "Generate a company brief and review missing information.", "System", company, None, critical_missing=False))
    if has_investors and company_id not in investor_maps:
        actions.append(make_action(base, "Run Investor Map Agent", "Company has investor data but no Investor Mapping Agent run yet.", "Generate an investor map to choose the best networking path.", "System", company, None, critical_missing=False))
    if high_fit and not company.get("careers_url"):
        actions.append(make_action(base, "Check Hiring", "High-fit company is missing a careers URL or hiring validation.", "Find current roles or hiring signals before outreach.", "System", company, None, critical_missing=True))
    if company.get("data_source") == "Crunchbase CSV" and not company.get("notes"):
        actions.append(make_action(base, "Research Company", "Imported Crunchbase company has no research notes yet.", "Do a focused research pass and add notes, role relevance, and traction signals.", "Import Review", company, None, critical_missing=True))
    if int(company.get("network_fit_score") or 0) >= 4 and has_investors:
        actions.append(make_action(base, "Draft Outreach", "Company has strong network fit and visible investor data.", "Draft a concise outreach angle to a founder, operator, or investor path.", "System", company, None, critical_missing=False))
    if company.get("data_source") == "Crunchbase CSV" and int(company.get("data_quality_score") or 0) < 5:
        actions.append(make_action(base, "Review Missing Data", "Imported company has low data quality.", "Review missing Crunchbase fields before spending outreach time.", "Import Review", company, None, critical_missing=True))

    brief = company_briefs.get(company_id) or {}
    missing_information = brief.get("missing_information") or []
    if missing_information:
        actions.append(make_action(base, "Review Missing Data", "Latest Company Brief Agent run found missing information.", "Resolve: " + ", ".join(missing_information[:4]), "Company Brief Agent", company, None, critical_missing=True))
    if brief.get("recommended_next_action"):
        actions.append(make_action(base, infer_action_type_from_text(brief["recommended_next_action"]), "Company Brief Agent recommended a next action.", brief["recommended_next_action"], "Company Brief Agent", company, None, critical_missing=False))

    investor_map = investor_maps.get(company_id) or {}
    missing_relationship_data = investor_map.get("missing_relationship_data") or []
    if missing_relationship_data:
        actions.append(make_action(base, "Review Missing Data", "Latest Investor Mapping Agent run found missing relationship data.", "Resolve: " + ", ".join(missing_relationship_data[:4]), "Investor Mapping Agent", company, None, critical_missing=True))
    if investor_map.get("recommended_next_action"):
        actions.append(make_action(base, infer_action_type_from_text(investor_map["recommended_next_action"]), "Investor Mapping Agent recommended a next action.", investor_map["recommended_next_action"], "Investor Mapping Agent", company, None, critical_missing=False))
    return actions


def build_investor_actions(investor: dict[str, Any]) -> list[dict[str, Any]]:
    actions = []
    priority = int(investor.get("priority_score") or 0)
    tracked_count = int(investor.get("tracked_company_count") or 0)
    base = {
        "target_type": "Investor",
        "target_id": int(investor.get("id") or 0),
        "target_name": investor.get("investor_name") or "",
        "research_links": build_research_links(investor),
    }
    if priority >= 30 and not investor.get("relevant_partner"):
        actions.append(make_action(base, "Find Partner", "Priority investor is missing a relevant partner.", investor.get("recommended_research_task") or "Find the partner most connected to the tracked portfolio company.", "Investor Enrichment", None, investor, critical_missing=True))
    if priority >= 30 and not investor.get("contact_path"):
        actions.append(make_action(base, "Find Contact Path", "Priority investor is missing a warm contact path.", "Find a warm intro route through alumni, advisors, portfolio founders, or known operators.", "Investor Enrichment", None, investor, critical_missing=True))
    if tracked_count >= 2:
        actions.append(make_action(base, "Research Investor", f"Investor appears across {tracked_count} tracked companies.", "Review portfolio overlap and decide whether this investor is worth a networking pass.", "Investor Enrichment", None, investor, critical_missing=False))
    if investor.get("relevant_partner") and investor.get("contact_path"):
        actions.append(make_action(base, "Draft Outreach", "Investor has both partner and contact path data.", "Draft a short perspective-seeking note using tracked portfolio overlap.", "Investor Enrichment", None, investor, critical_missing=False))
    if investor.get("enrichment_status") == "Ready for Outreach":
        actions.append(make_action(base, "Send Outreach", "Investor is marked Ready for Outreach.", "Send a human-reviewed outreach note or ask for a warm intro.", "Investor Enrichment", None, investor, critical_missing=False))
    return actions


def infer_action_type_from_text(text: str) -> str:
    lower = text.lower()
    if "brief" in lower:
        return "Run Company Brief Agent"
    if "investor map" in lower or "map" in lower:
        return "Run Investor Map Agent"
    if "partner" in lower:
        return "Find Partner"
    if "contact path" in lower or "warm" in lower or "intro" in lower:
        return "Find Contact Path"
    if "career" in lower or "hiring" in lower or "roles" in lower:
        return "Check Hiring"
    if "draft" in lower or "note" in lower or "outreach" in lower:
        return "Draft Outreach"
    return "Research Company"


def make_action(
    base: dict[str, Any],
    action_type: str,
    reason: str,
    recommended_action: str,
    source: str,
    company: dict[str, Any] | None,
    investor: dict[str, Any] | None,
    critical_missing: bool,
) -> dict[str, Any]:
    priority = calculate_action_priority(action_type, company, investor, critical_missing)
    return {
        **base,
        "action_type": action_type,
        "priority_score": priority,
        "reason": reason,
        "recommended_action": recommended_action,
        "status": "New",
        "due_date": "",
        "source": source,
        "outreach_draft": "",
        "notes": "",
    }


def calculate_action_priority(
    action_type: str,
    company: dict[str, Any] | None,
    investor: dict[str, Any] | None,
    critical_missing: bool,
) -> int:
    score = 20
    if company and int(company.get("total_score") or 0) >= 16:
        score += 30
    if action_type in OUTREACH_UNBLOCKING_ACTIONS:
        score += 20
    if investor and int(investor.get("lead_investment_count") or 0) >= 1:
        score += 15
    if investor and int(investor.get("tracked_company_count") or 0) >= 2:
        score += 15
    if company and company.get("data_source") == "Crunchbase CSV":
        score += 10
    stage = ((company or {}).get("latest_funding_round") or (investor or {}).get("stage_focus") or "").lower()
    if any(token in stage for token in ["seed", "series a", "series b"]):
        score += 10
    if investor and investor.get("contact_path"):
        score += 10
    if critical_missing:
        score -= 15
    if company and int(company.get("data_quality_score") or 0) and int(company.get("data_quality_score") or 0) < 5:
        score -= 10
    return max(0, min(score, 100))


def upsert_action_item(conn: Any, action: dict[str, Any]) -> str:
    existing = conn.execute(
        """
        SELECT *
        FROM action_items
        WHERE target_type = ? AND target_id = ? AND action_type = ?
            AND status NOT IN ('Done', 'Skipped')
        ORDER BY id DESC
        LIMIT 1
        """,
        (action["target_type"], action["target_id"], action["action_type"]),
    ).fetchone()
    links_json = json.dumps(action.get("research_links") or {})
    if existing:
        conn.execute(
            """
            UPDATE action_items
            SET target_name = ?, priority_score = ?, reason = ?, recommended_action = ?,
                source = ?, research_links = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                action["target_name"],
                action["priority_score"],
                action["reason"],
                action["recommended_action"],
                action["source"],
                links_json,
                existing["id"],
            ),
        )
        return "updated"
    conn.execute(
        """
        INSERT INTO action_items (
            action_type, target_type, target_id, target_name, priority_score,
            reason, recommended_action, status, due_date, source, research_links,
            outreach_draft, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            action["action_type"],
            action["target_type"],
            action["target_id"],
            action["target_name"],
            action["priority_score"],
            action["reason"],
            action["recommended_action"],
            action["status"],
            action["due_date"],
            action["source"],
            links_json,
            action["outreach_draft"],
            action["notes"],
        ),
    )
    return "created"


def list_actions_query(
    conn: Any,
    status: str | None,
    action_type: str | None,
    target_type: str | None,
    min_priority: int | None,
    source: str | None,
    weekly: bool = False,
) -> list[dict[str, Any]]:
    clauses = []
    params: list[Any] = []
    if weekly:
        clauses.append("status NOT IN ('Done', 'Skipped')")
    elif status:
        clauses.append("status = ?")
        params.append(status)
    if action_type:
        clauses.append("action_type = ?")
        params.append(action_type)
    if target_type:
        clauses.append("target_type = ?")
        params.append(target_type)
    if min_priority is not None:
        clauses.append("priority_score >= ?")
        params.append(min_priority)
    if source:
        clauses.append("source = ?")
        params.append(source)
    query = "SELECT * FROM action_items"
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY priority_score DESC, updated_at DESC, id DESC"
    return [action_row_to_dict(row) for row in conn.execute(query, params).fetchall()]


def build_company_research_links(company: dict[str, Any]) -> dict[str, str]:
    name = company.get("company_name") or ""
    investors = parse_investor_list(company.get("lead_investors") or company.get("other_investors") or "")
    links = {
        "Google": f"https://www.google.com/search?q={quote_plus(name)}",
        "LinkedIn Search": f"https://www.linkedin.com/search/results/all/?keywords={quote_plus(name)}",
        "Careers Search": f"https://www.google.com/search?q={quote_plus(name + ' careers jobs')}",
    }
    if company.get("crunchbase_url"):
        links["Crunchbase"] = company["crunchbase_url"]
    if company.get("website"):
        links["Website"] = company["website"]
    if investors:
        links["Investor + Funding"] = f"https://www.google.com/search?q={quote_plus(investors[0] + ' ' + name + ' funding')}"
    return links


def generate_outreach_draft_for_action(action: dict[str, Any], target: dict[str, Any] | None) -> str:
    target = target or {}
    if action.get("target_type") == "Investor":
        investor_name = action.get("target_name") or target.get("investor_name") or "there"
        companies = split_tags(target.get("top_tracked_companies") or target.get("portfolio_companies") or "")[:2]
        company_text = ", ".join(companies) if companies else "a few companies I am tracking"
        category = target.get("sector_focus") or target.get("thesis_tags") or "startup networking"
        return (
            f"Hi {investor_name}, I am mapping {category} companies and noticed your connection to {company_text}. "
            "My background is CS + Econ with VC diligence, AI/product work, and a strong interest in sports, wearables, and health. "
            "Would you be open to a short conversation so I can learn how you think about this category?"
        )
    company_name = action.get("target_name") or target.get("company_name") or "your company"
    sector = target.get("sector") or "your market"
    funding = " ".join([target.get("latest_funding_round") or "", target.get("funding_amount") or ""]).strip()
    investors = ", ".join([target.get("lead_investors") or "", target.get("other_investors") or ""]).strip(" ,")
    signal = funding or investors or "the recent company momentum"
    return (
        f"Hi {company_name} team, I have been researching {sector} startups and noticed {signal}. "
        "My background is CS + Econ with VC diligence, AI/product work, and a strong interest in sports, wearables, and health. "
        "Would someone on the team be open to a short conversation about what you are building and where help might be useful?"
    )


@app.get("/health")
@app.get("/api/health")
@timed_endpoint("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/debug/db")
@timed_endpoint("/debug/db")
def debug_db() -> dict[str, Any]:
    db_exists = DB_PATH.exists()
    size_mb = round(DB_PATH.stat().st_size / (1024 * 1024), 3) if db_exists else 0
    table_names: set[str] = set()
    with get_connection() as conn:
        table_names = {
            row["name"]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        }
        company_count = conn.execute("SELECT COUNT(*) FROM companies").fetchone()[0]
        investor_count = conn.execute("SELECT COUNT(*) FROM investors").fetchone()[0]
        agent_run_count = conn.execute("SELECT COUNT(*) FROM agent_runs").fetchone()[0]
        action_item_count = (
            conn.execute("SELECT COUNT(*) FROM action_items").fetchone()[0]
            if "action_items" in table_names
            else None
        )
        sample_company_names = [
            row["company_name"]
            for row in conn.execute(
                "SELECT company_name FROM companies ORDER BY updated_at DESC, id DESC LIMIT 10"
            ).fetchall()
        ]

    return {
        "database_path": str(DB_PATH),
        "database_exists": db_exists,
        "database_size_mb": size_mb,
        "company_count": company_count,
        "investor_count": investor_count,
        "agent_run_count": agent_run_count,
        "action_item_count": action_item_count,
        "sample_company_names": sample_company_names,
        "backend_start_time": BACKEND_START_TIME,
        "request_timestamp": datetime.now(timezone.utc).isoformat(),
    }


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


@app.get("/companies")
@app.get("/api/companies")
@timed_endpoint("/companies")
def list_companies(
    sector: str | None = None,
    location: str | None = None,
    status: str | None = None,
    min_score: int | None = None,
    funding_round: str | None = None,
    investor: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
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

    query = COMPANY_LIST_SELECT
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY total_score DESC, funding_date DESC, company_name ASC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    with get_connection() as conn:
        return [row_to_dict(row) for row in conn.execute(query, params).fetchall()]


@app.get("/companies/{company_id}")
@app.get("/api/companies/{company_id}")
def get_company(company_id: int) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute(COMPANY_SELECT + " WHERE id = ?", (company_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Company not found")
    return row_to_dict(row)


@app.delete("/companies/{company_id}")
@app.delete("/api/companies/{company_id}")
def delete_company(company_id: int) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute("SELECT id, company_name FROM companies WHERE id = ?", (company_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Company not found")
        conn.execute(
            "DELETE FROM agent_runs WHERE target_type = ? AND target_id = ?",
            ("company", company_id),
        )
        conn.execute("DELETE FROM companies WHERE id = ?", (company_id,))
    return {"deleted": True, "id": company_id, "company_name": row["company_name"]}


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


@app.get("/filter-options")
def filter_options_alias() -> dict[str, list[str]]:
    return filter_options()


@app.post("/investors/rebuild-profiles")
def rebuild_investor_profiles() -> dict[str, Any]:
    with get_connection() as conn:
        return rebuild_investor_profiles_from_companies(conn)


@app.get("/investors/enrichment-queue")
def get_investor_enrichment_queue() -> list[dict[str, Any]]:
    with get_connection() as conn:
        return build_enrichment_queue_rows(conn)


@app.post("/actions/rebuild-weekly")
def rebuild_weekly_actions() -> dict[str, Any]:
    with get_connection() as conn:
        return generate_weekly_action_queue(conn)


@app.get("/actions")
def list_actions(
    status: str | None = None,
    action_type: str | None = None,
    target_type: str | None = None,
    min_priority: int | None = None,
    source: str | None = None,
) -> list[dict[str, Any]]:
    with get_connection() as conn:
        return list_actions_query(conn, status, action_type, target_type, min_priority, source)


@app.get("/actions/weekly")
def list_weekly_actions() -> list[dict[str, Any]]:
    with get_connection() as conn:
        return list_actions_query(conn, None, None, None, None, None, weekly=True)


@app.patch("/actions/{action_id}")
def update_action(action_id: int, payload: ActionUpdate) -> dict[str, Any]:
    completed_at = datetime.now(timezone.utc).isoformat() if payload.status in {"Done", "Skipped"} else ""
    with get_connection() as conn:
        exists = conn.execute("SELECT id FROM action_items WHERE id = ?", (action_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Action not found")
        conn.execute(
            """
            UPDATE action_items
            SET status = ?, due_date = ?, notes = ?, recommended_action = ?,
                outreach_draft = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                payload.status,
                payload.due_date,
                payload.notes,
                payload.recommended_action,
                payload.outreach_draft,
                completed_at,
                action_id,
            ),
        )
        row = conn.execute("SELECT * FROM action_items WHERE id = ?", (action_id,)).fetchone()
    return action_row_to_dict(row)


@app.delete("/actions/{action_id}")
def delete_action(action_id: int) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute("SELECT id FROM action_items WHERE id = ?", (action_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Action not found")
        conn.execute("DELETE FROM action_items WHERE id = ?", (action_id,))
    return {"deleted": True, "id": action_id}


@app.post("/actions/{action_id}/generate-outreach-draft")
def generate_action_outreach_draft(action_id: int) -> dict[str, Any]:
    with get_connection() as conn:
        action = conn.execute("SELECT * FROM action_items WHERE id = ?", (action_id,)).fetchone()
        if action is None:
            raise HTTPException(status_code=404, detail="Action not found")
        action_data = action_row_to_dict(action)
        target = None
        if action_data["target_type"] == "Company":
            target_row = conn.execute(COMPANY_SELECT + " WHERE id = ?", (action_data["target_id"],)).fetchone()
            target = row_to_dict(target_row) if target_row else {}
        elif action_data["target_type"] == "Investor":
            target_row = conn.execute("SELECT * FROM investors WHERE id = ?", (action_data["target_id"],)).fetchone()
            target = investor_row_to_dict(target_row) if target_row else {}
        draft = generate_outreach_draft_for_action(action_data, target)
        conn.execute(
            """
            UPDATE action_items
            SET outreach_draft = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (draft, action_id),
        )
        row = conn.execute("SELECT * FROM action_items WHERE id = ?", (action_id,)).fetchone()
    return action_row_to_dict(row)


@app.get("/investors")
@app.get("/api/investors")
@timed_endpoint("/investors")
def list_investors() -> list[dict[str, Any]]:
    with get_connection() as conn:
        return [
            investor_row_to_dict(row)
            for row in conn.execute("SELECT * FROM investors ORDER BY priority_score DESC, investor_name ASC").fetchall()
        ]


@app.post("/investors")
@app.post("/api/investors")
def create_investor(payload: InvestorUpdate) -> dict[str, Any]:
    canonical = canonicalize_investor_name(payload.investor_name)
    values = payload.dict()
    values["display_name"] = values.get("display_name") or canonical["display_name"]
    values["canonical_name"] = values.get("canonical_name") or canonical["canonical_name"]
    values["dedupe_review_needed"] = int(bool(values.get("dedupe_review_needed") or canonical["dedupe_review_needed"]))
    values["missing_fields"] = json.dumps(values.get("missing_fields", [])) if isinstance(values.get("missing_fields"), list) else values.get("missing_fields", "")
    values["enrichment_warnings"] = json.dumps(values.get("enrichment_warnings", [])) if isinstance(values.get("enrichment_warnings"), list) else values.get("enrichment_warnings", "")
    with get_connection() as conn:
        try:
            placeholders = ", ".join(["?"] * len(INVESTOR_PROFILE_FIELDS))
            cursor = conn.execute(
                f"""
                INSERT INTO investors ({", ".join(INVESTOR_PROFILE_FIELDS)})
                VALUES ({placeholders})
                """,
                [values.get(field, "") for field in INVESTOR_PROFILE_FIELDS],
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Investor name must be unique.") from exc
        row = conn.execute("SELECT * FROM investors WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return investor_row_to_dict(row)


@app.patch("/investors/{investor_id}")
@app.patch("/api/investors/{investor_id}")
def update_investor(investor_id: int, payload: InvestorUpdate) -> dict[str, Any]:
    canonical = canonicalize_investor_name(payload.investor_name)
    values = payload.dict()
    values["display_name"] = values.get("display_name") or canonical["display_name"]
    values["canonical_name"] = values.get("canonical_name") or canonical["canonical_name"]
    values["dedupe_review_needed"] = int(bool(values.get("dedupe_review_needed") or canonical["dedupe_review_needed"]))
    if isinstance(values.get("missing_fields"), list):
        values["missing_fields"] = json.dumps(values["missing_fields"])
    if isinstance(values.get("enrichment_warnings"), list):
        values["enrichment_warnings"] = json.dumps(values["enrichment_warnings"])
    with get_connection() as conn:
        exists = conn.execute("SELECT id FROM investors WHERE id = ?", (investor_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Investor not found")
        assignments = ", ".join([f"{field} = ?" for field in INVESTOR_PROFILE_FIELDS])
        conn.execute(
            f"""
            UPDATE investors
            SET {assignments}, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            [values.get(field, "") for field in INVESTOR_PROFILE_FIELDS] + [investor_id],
        )
        row = conn.execute("SELECT * FROM investors WHERE id = ?", (investor_id,)).fetchone()
    return investor_row_to_dict(row)
