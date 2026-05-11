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
    thesis_tags: str = ""
    portfolio_companies: str = ""
    relevant_partner: str = ""
    contact_path: str = ""
    priority_score: int = Field(default=3, ge=1, le=5)
    notes: str = ""
