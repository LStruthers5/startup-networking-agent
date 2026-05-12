from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Status = Literal[
    "New",
    "Researching",
    "Investor Mapped",
    "Outreach Drafted",
    "Contacted",
    "Replied",
    "Passed",
]


class CompanyUpdate(BaseModel):
    market_fit_score: int = Field(ge=1, le=5)
    personal_fit_score: int = Field(ge=1, le=5)
    hiring_fit_score: int = Field(ge=1, le=5)
    network_fit_score: int = Field(ge=1, le=5)
    status: Status
    notes: str = ""
    next_action: str = ""
    outreach_angle: str = ""


class InvestorUpdate(BaseModel):
    investor_name: str = Field(min_length=1)
    display_name: str = ""
    canonical_name: str = ""
    aliases: str = ""
    dedupe_review_needed: bool = False
    investor_type: str = ""
    thesis_tags: str = ""
    stage_focus: str = ""
    sector_focus: str = ""
    location: str = ""
    website: str = ""
    linkedin_url: str = ""
    crunchbase_url: str = ""
    portfolio_companies: str = ""
    tracked_company_count: int = 0
    lead_investment_count: int = 0
    co_investment_count: int = 0
    high_fit_company_count: int = 0
    average_company_fit_score: float = 0
    top_tracked_companies: str = ""
    sectors_from_portfolio: str = ""
    stages_from_portfolio: str = ""
    last_seen_funding_date: str = ""
    portfolio_overlap_summary: str = ""
    relevant_partner: str = ""
    partner_linkedin_url: str = ""
    talent_or_platform_contact: str = ""
    contact_path: str = ""
    relationship_strength: str = "Unknown"
    enrichment_status: str = "New"
    recommended_research_task: str = ""
    next_action: str = ""
    priority_score: int = Field(default=0, ge=0, le=100)
    notes: str = ""
    data_source: str = ""
    last_enriched_at: str = ""
    enrichment_warnings: str | list[str] = ""
    missing_fields: str | list[str] = ""


class ActionUpdate(BaseModel):
    status: str = "New"
    due_date: str = ""
    notes: str = ""
    recommended_action: str = ""
    outreach_draft: str = ""
