from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "networking_tracker.db"


def get_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS companies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_name TEXT NOT NULL UNIQUE,
                sector TEXT DEFAULT '',
                description TEXT DEFAULT '',
                location TEXT DEFAULT '',
                website TEXT DEFAULT '',
                latest_funding_round TEXT DEFAULT '',
                funding_amount TEXT DEFAULT '',
                funding_date TEXT DEFAULT '',
                lead_investors TEXT DEFAULT '',
                other_investors TEXT DEFAULT '',
                employee_count TEXT DEFAULT '',
                crunchbase_url TEXT DEFAULT '',
                careers_url TEXT DEFAULT '',
                market_fit_score INTEGER DEFAULT 3,
                personal_fit_score INTEGER DEFAULT 3,
                hiring_fit_score INTEGER DEFAULT 3,
                network_fit_score INTEGER DEFAULT 3,
                status TEXT DEFAULT 'New',
                notes TEXT DEFAULT '',
                next_action TEXT DEFAULT '',
                outreach_angle TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS investors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                investor_name TEXT NOT NULL UNIQUE,
                thesis_tags TEXT DEFAULT '',
                portfolio_companies TEXT DEFAULT '',
                relevant_partner TEXT DEFAULT '',
                contact_path TEXT DEFAULT '',
                priority_score INTEGER DEFAULT 3,
                notes TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            """
        )


def seed_if_empty() -> None:
    with get_connection() as conn:
        company_count = conn.execute("SELECT COUNT(*) FROM companies").fetchone()[0]
        investor_count = conn.execute("SELECT COUNT(*) FROM investors").fetchone()[0]

        if company_count == 0:
            conn.executemany(
                """
                INSERT INTO companies (
                    company_name, sector, description, location, website,
                    latest_funding_round, funding_amount, funding_date,
                    lead_investors, other_investors, employee_count,
                    crunchbase_url, careers_url, market_fit_score,
                    personal_fit_score, hiring_fit_score, network_fit_score,
                    status, notes, next_action, outreach_angle
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                SAMPLE_COMPANIES,
            )

        if investor_count == 0:
            conn.executemany(
                """
                INSERT INTO investors (
                    investor_name, thesis_tags, portfolio_companies,
                    relevant_partner, contact_path, priority_score, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                SAMPLE_INVESTORS,
            )


SAMPLE_COMPANIES: Iterable[tuple] = [
    (
        "PulseForge Health",
        "AI health",
        "AI coaching layer that turns wearable signals into recovery and training recommendations.",
        "San Francisco, CA",
        "https://example.com/pulseforge",
        "Seed",
        "$4.2M",
        "2025-09-18",
        "Trailhead Ventures",
        "Operator Collective, Bay Health Angels",
        "18",
        "https://www.crunchbase.com/organization/pulseforge-health",
        "https://example.com/pulseforge/careers",
        5,
        5,
        4,
        3,
        "Researching",
        "Strong overlap with wearables, training, and AI health. Research product adoption and clinical claims.",
        "Find product or growth lead; map Trailhead partner connection.",
        "Lead with interest in translating wearable data into practical coaching for serious amateurs.",
    ),
    (
        "RosterOps",
        "sports tech",
        "Operations software for youth sports clubs: payments, scheduling, rosters, and parent communications.",
        "Los Angeles, CA",
        "https://example.com/rosterops",
        "Series A",
        "$11M",
        "2025-06-04",
        "Courtline Capital",
        "SaaS Valley Fund",
        "44",
        "https://www.crunchbase.com/organization/rosterops",
        "https://example.com/rosterops/jobs",
        4,
        4,
        5,
        4,
        "Investor Mapped",
        "Hiring across customer success and ops. Good SMB software angle with sports domain.",
        "Draft outreach to VP Ops around scaling club onboarding.",
        "Position around operator empathy for fragmented SMB workflows in sports organizations.",
    ),
    (
        "LedgerLoop",
        "finance/operations software",
        "Cash flow planning and invoice automation for multi-location service businesses.",
        "San Diego, CA",
        "https://example.com/ledgerloop",
        "Pre-Seed",
        "$1.8M",
        "2025-11-12",
        "Pacific Seed Partners",
        "FinOps Angels",
        "9",
        "https://www.crunchbase.com/organization/ledgerloop",
        "https://example.com/ledgerloop/careers",
        3,
        3,
        3,
        2,
        "New",
        "Potentially interesting SMB operations wedge; needs customer evidence.",
        "Research customers and founder backgrounds.",
        "Ask about finance workflows for local service operators and early GTM lessons.",
    ),
    (
        "FormFactor Wearables",
        "wearables",
        "Smart compression apparel that tracks load, asymmetry, and fatigue for rehab and performance.",
        "Palo Alto, CA",
        "https://example.com/formfactor",
        "Seed",
        "$6.5M",
        "2025-03-27",
        "Kinetic Ventures",
        "MediSport Capital, Stanford Angels",
        "27",
        "https://www.crunchbase.com/organization/formfactor-wearables",
        "https://example.com/formfactor/careers",
        5,
        5,
        4,
        5,
        "Outreach Drafted",
        "Excellent domain fit. Investor base likely has sports medicine connections.",
        "Send founder note after checking recent pilots.",
        "Reference interest in the gap between consumer wearables and clinician-grade rehab feedback.",
    ),
]


SAMPLE_INVESTORS: Iterable[tuple] = [
    (
        "Trailhead Ventures",
        "AI health, wearables, consumer health",
        "PulseForge Health",
        "Maya Chen",
        "Warm intro via Bay Area healthtech founders; otherwise concise thesis-driven cold note.",
        4,
        "Looks active around applied AI and health behavior change.",
    ),
    (
        "Courtline Capital",
        "sports tech, vertical SaaS, SMB software",
        "RosterOps",
        "Evan Brooks",
        "Target sports-tech operators and alumni portfolio founders for intro paths.",
        5,
        "Best near-term investor mapping target because portfolio matches two focus sectors.",
    ),
    (
        "Kinetic Ventures",
        "wearables, fitness, digital health",
        "FormFactor Wearables",
        "Priya Shah",
        "Look for Stanford sports medicine or rehab tech overlap.",
        5,
        "High relevance for wearables and fitness infrastructure.",
    ),
]
