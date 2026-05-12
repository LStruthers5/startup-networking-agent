from __future__ import annotations

import json
import re
from typing import Any


FOCUS_SECTORS = {
    "wearables",
    "sports tech",
    "digital health",
    "fitness",
    "ai health",
    "smb software",
    "finance/operations software",
}


def generate_company_networking_brief(company: dict[str, Any]) -> dict[str, Any]:
    total_score = int(company.get("total_score") or 0)
    sector = (company.get("sector") or "").strip()
    lead_investors = company.get("lead_investors") or ""
    other_investors = company.get("other_investors") or ""
    investors = ", ".join([value for value in [lead_investors, other_investors] if value])
    has_funding = bool(company.get("latest_funding_round") or company.get("funding_amount"))
    has_careers = bool(company.get("careers_url"))
    has_investors = bool(investors)

    market_score = int(company.get("market_fit_score") or 0)
    personal_score = int(company.get("personal_fit_score") or 0)
    hiring_score = int(company.get("hiring_fit_score") or 0)
    network_score = int(company.get("network_fit_score") or 0)

    thesis_fit = build_thesis_fit(company, sector, total_score, market_score, personal_score)
    investor_path = build_investor_path(company, investors, network_score)
    hiring_signal = build_hiring_signal(company, hiring_score, has_careers)
    outreach_angle = build_outreach_angle(company, thesis_fit, investor_path)
    missing_information = build_missing_information(company)
    data_quality_score = int(company.get("data_quality_score") or 0)
    data_warnings = parse_saved_warnings(company.get("data_warnings") or "")

    confidence = 40
    confidence += 10 if sector.lower() in FOCUS_SECTORS else 4
    confidence += 10 if company.get("description") else 0
    confidence += 10 if has_funding else 0
    confidence += 10 if has_investors else 0
    confidence += 8 if company.get("notes") else 0
    confidence += 7 if company.get("outreach_angle") else 0
    confidence += 5 if has_careers else 0
    if company.get("data_source") == "Crunchbase CSV":
        confidence += 3
        if data_quality_score and data_quality_score < 5:
            confidence -= 15
        confidence -= min(len(data_warnings) * 2, 10)

    return {
        "company_snapshot": {
            "company_name": company.get("company_name"),
            "sector": sector,
            "location": company.get("location"),
            "website": company.get("website"),
            "funding": {
                "latest_round": company.get("latest_funding_round"),
                "amount": company.get("funding_amount"),
                "date": company.get("funding_date"),
            },
            "investors": {
                "lead": lead_investors,
                "other": other_investors,
            },
            "employee_count": company.get("employee_count"),
            "status": company.get("status"),
            "total_score": total_score,
            "data_source": company.get("data_source"),
            "data_quality_score": data_quality_score,
            "data_warnings": data_warnings,
            "crunchbase_url": company.get("crunchbase_url"),
        },
        "source_context": build_source_context(company, data_quality_score, data_warnings),
        "thesis_fit": thesis_fit,
        "investor_networking_path": investor_path,
        "hiring_signal": hiring_signal,
        "suggested_outreach_angle": outreach_angle,
        "smart_questions": build_smart_questions(company, sector, has_investors),
        "recommended_next_action": build_next_action(company, total_score, has_investors),
        "missing_information": missing_information,
        "confidence_score": max(20, min(confidence, 95)),
    }


def generate_investor_mapping_brief(
    company: dict[str, Any],
    linked_investors: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    linked_investors = linked_investors or []
    lead_investors = parse_investor_names(company.get("lead_investors") or "")
    other_investors = parse_investor_names(company.get("other_investors") or "")
    known_investors = dedupe_names(lead_investors + other_investors)
    thesis = infer_investor_thesis(company)
    stage_signal = infer_stage_signal(company.get("latest_funding_round") or "")
    network_score = int(company.get("network_fit_score") or 0)
    contact_types = infer_contact_types(company)
    missing_data = identify_missing_relationship_data(company, known_investors, linked_investors)
    data_quality_score = int(company.get("data_quality_score") or 0)
    data_warnings = parse_saved_warnings(company.get("data_warnings") or "")

    investor_paths = [
        build_investor_mapping_path(investor_name, company, linked_investors, investor_name in lead_investors)
        for investor_name in known_investors
    ]
    investor_paths.sort(key=lambda path: {"High": 0, "Medium": 1, "Low": 2}[path["path_strength"]])

    has_multiple_paths = len(known_investors) > 1
    strongest_name = investor_paths[0]["investor_name"] if investor_paths else ""

    confidence = 35
    confidence += 15 if lead_investors else 0
    confidence += 10 if other_investors else 0
    confidence += 12 if linked_investors else 0
    confidence += 10 if network_score >= 4 else 5 if network_score == 3 else 0
    confidence += 8 if company.get("latest_funding_round") else 0
    confidence += 5 if company.get("notes") else 0
    if company.get("data_source") == "Crunchbase CSV":
        confidence += 3
        if data_quality_score and data_quality_score < 5:
            confidence -= 15
        confidence -= min(len(data_warnings) * 2, 10)
    confidence -= min(len(missing_data) * 4, 20)

    return {
        "investor_summary": {
            "known_investors": known_investors,
            "lead_investors": lead_investors,
            "other_investors": other_investors,
            "summary": build_investor_summary(company, known_investors, has_multiple_paths),
        },
        "control_tower_classification": {
            "company_sector": company.get("sector") or "",
            "likely_investor_thesis": thesis,
            "stage_signal": stage_signal,
            "networking_relevance": infer_networking_relevance(network_score, known_investors, linked_investors),
            "data_source": company.get("data_source") or "",
            "data_quality_score": data_quality_score,
        },
        "strongest_investor_paths": investor_paths,
        "portfolio_overlap_angle": build_portfolio_overlap_angle(company, linked_investors),
        "likely_contact_types": contact_types,
        "warm_intro_hypotheses": build_warm_intro_hypotheses(company, investor_paths, linked_investors),
        "suggested_outreach_angle": build_investor_map_outreach_angle(company, strongest_name, thesis),
        "suggested_research_steps": build_investor_research_steps(company, known_investors, linked_investors),
        "recommended_next_action": build_investor_map_next_action(company, investor_paths),
        "missing_relationship_data": missing_data,
        "confidence_score": max(20, min(confidence, 95)),
    }


def parse_saved_warnings(value: str) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return [value]
    if isinstance(parsed, list):
        return [str(item) for item in parsed]
    return [str(parsed)]


def build_source_context(
    company: dict[str, Any],
    data_quality_score: int,
    data_warnings: list[str],
) -> dict[str, Any]:
    source = company.get("data_source") or "Manual / seed data"
    if source == "Crunchbase CSV":
        summary = "This brief is based partly on imported Crunchbase CSV data."
    else:
        summary = "This brief is based on manually entered or seeded app data."
    if data_quality_score and data_quality_score < 5:
        summary += " Data quality is limited, so validate key fields before outreach."
    return {
        "data_source": source,
        "data_quality_score": data_quality_score,
        "data_warnings": data_warnings,
        "summary": summary,
    }


def parse_investor_names(value: str) -> list[str]:
    return dedupe_names([item.strip() for item in re.split(r"[,;]", value or "") if item.strip()])


def dedupe_names(names: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for name in names:
        key = name.lower()
        if key not in seen:
            seen.add(key)
            result.append(name)
    return result


def infer_investor_thesis(company: dict[str, Any]) -> list[str]:
    text = " ".join(
        [
            company.get("sector") or "",
            company.get("description") or "",
            company.get("notes") or "",
        ]
    ).lower()
    thesis_map = [
        ("wearable", "wearables"),
        ("sports", "sports tech"),
        ("health", "digital health"),
        ("fitness", "fitness"),
        ("ai", "AI health"),
        ("smb", "SMB software"),
        ("finance", "finance software"),
        ("operations", "operations software"),
        ("ops", "operations software"),
    ]
    inferred = [label for keyword, label in thesis_map if keyword in text]
    return dedupe_names(inferred) or ["general early-stage software"]


def infer_stage_signal(round_name: str) -> str:
    round_lower = round_name.lower()
    if any(stage in round_lower for stage in ["pre-seed", "pre seed", "seed"]):
        return "Seed-stage signal: prioritize founder, lead investor, and early operator conversations."
    if "series a" in round_lower:
        return "Series A signal: prioritize founder, lead investor, functional leader, and early GTM/operator paths."
    if any(stage in round_lower for stage in ["series b", "series c", "series d", "growth"]):
        return "Growth-stage signal: prioritize platform, talent, portfolio operators, and functional leads."
    return "Unknown stage: confirm funding stage before choosing the outreach path."


def infer_contact_types(company: dict[str, Any]) -> list[str]:
    round_lower = (company.get("latest_funding_round") or "").lower()
    if any(stage in round_lower for stage in ["series b", "series c", "series d", "growth"]):
        return [
            "Partner",
            "Platform / Talent",
            "Founder in portfolio",
            "Operator in portfolio",
            "Recruiter",
        ]
    if any(stage in round_lower for stage in ["pre-seed", "pre seed", "seed", "series a"]):
        return [
            "Partner",
            "Principal",
            "Associate",
            "Founder in portfolio",
            "Operator in portfolio",
        ]
    return [
        "Partner",
        "Principal",
        "Associate",
        "Platform / Talent",
        "Founder in portfolio",
        "Operator in portfolio",
        "Recruiter",
    ]


def score_path_strength(
    investor_name: str,
    company: dict[str, Any],
    investor_record: dict[str, Any] | None,
    is_lead: bool,
) -> str:
    score = int(company.get("network_fit_score") or 0)
    if is_lead:
        score += 2
    if investor_record:
        score += 1
        if investor_record.get("relevant_partner"):
            score += 1
        if investor_record.get("contact_path"):
            score += 2
        if int(investor_record.get("tracked_company_count") or 0) >= 2:
            score += 1
        if int(investor_record.get("priority_score") or 0) >= 70:
            score += 1
    if score >= 7:
        return "High"
    if score >= 4:
        return "Medium"
    return "Low"


def build_investor_mapping_path(
    investor_name: str,
    company: dict[str, Any],
    linked_investors: list[dict[str, Any]],
    is_lead: bool,
) -> dict[str, str]:
    investor_record = find_linked_investor(investor_name, linked_investors)
    strength = score_path_strength(investor_name, company, investor_record, is_lead)
    partner = investor_record.get("relevant_partner") if investor_record else ""
    contact_path = investor_record.get("contact_path") if investor_record else ""
    priority_score = int(investor_record.get("priority_score") or 0) if investor_record else 0
    tracked_count = int(investor_record.get("tracked_company_count") or 0) if investor_record else 0
    overlap_summary = investor_record.get("portfolio_overlap_summary") if investor_record else ""

    if partner and contact_path:
        reason = f"{investor_name} has a saved partner ({partner}) and contact path."
        first_step = f"Validate {partner}'s relationship to {company.get('company_name')} and use the saved contact path."
    elif contact_path:
        reason = f"{investor_name} has a saved warm path: {contact_path}."
        first_step = "Use the saved contact path after confirming the right partner or portfolio operator."
    elif partner:
        reason = f"{investor_name} has a saved relevant partner: {partner}."
        first_step = f"Research {partner}'s portfolio work and look for a warm path."
    elif is_lead:
        reason = f"{investor_name} is listed as a lead investor, so it is probably the highest-leverage investor path."
        first_step = "Identify the partner who led or announced the round."
    else:
        reason = f"{investor_name} is connected to the round but needs more relationship detail."
        first_step = "Research portfolio overlap and find the most relevant partner or operator."

    if tracked_count >= 2:
        reason += f" It also appears across {tracked_count} tracked companies."
    if priority_score >= 70:
        reason += f" Its enriched investor priority score is high ({priority_score}/100)."
    if overlap_summary:
        first_step += f" Portfolio context: {overlap_summary}"

    return {
        "investor_name": investor_name,
        "path_strength": strength,
        "reason": reason,
        "best_first_step": first_step,
    }


def find_linked_investor(
    investor_name: str,
    linked_investors: list[dict[str, Any]],
) -> dict[str, Any] | None:
    for investor in linked_investors:
        if (investor.get("investor_name") or "").lower() == investor_name.lower():
            return investor
    return None


def identify_missing_relationship_data(
    company: dict[str, Any],
    known_investors: list[str],
    linked_investors: list[dict[str, Any]],
) -> list[str]:
    missing: list[str] = []
    if not known_investors:
        missing.append("Investor names")
    for investor_name in known_investors:
        record = find_linked_investor(investor_name, linked_investors)
        if not record:
            missing.append(f"Investor record for {investor_name}")
            continue
        if not record.get("relevant_partner"):
            missing.append(f"Relevant partner at {investor_name}")
        if not record.get("contact_path"):
            missing.append(f"Contact path for {investor_name}")
        if not record.get("portfolio_companies"):
            missing.append(f"Portfolio overlap for {investor_name}")
        for saved_missing in record.get("missing_fields") or []:
            label = f"{investor_name}: {saved_missing}"
            if label not in missing:
                missing.append(label)
        for warning in record.get("enrichment_warnings") or []:
            label = f"{investor_name}: {warning}"
            if label not in missing:
                missing.append(label)
    if not company.get("careers_url"):
        missing.append("Careers URL or hiring signal")
    if not company.get("notes"):
        missing.append("Company research notes")
    for warning in parse_saved_warnings(company.get("data_warnings") or ""):
        if warning not in missing:
            missing.append(warning)
    return missing


def build_investor_summary(
    company: dict[str, Any],
    known_investors: list[str],
    has_multiple_paths: bool,
) -> str:
    if not known_investors:
        return "No investors are saved yet, so the first task is relationship discovery."
    path_note = "multiple possible networking paths" if has_multiple_paths else "one visible investor path"
    return (
        f"{company.get('company_name')} has {path_note}: {', '.join(known_investors)}. "
        "Use this map to choose the investor or portfolio route most likely to create a useful conversation."
    )


def infer_networking_relevance(
    network_score: int,
    known_investors: list[str],
    linked_investors: list[dict[str, Any]],
) -> str:
    if network_score >= 4 and linked_investors:
        return "High: strong network score plus saved investor relationship data."
    if network_score >= 4:
        return "High potential: network score is strong, but relationship details need validation."
    if known_investors:
        return "Medium: investors are known, but the warm path is not fully mapped."
    return "Low until investor names and relationship paths are added."


def build_portfolio_overlap_angle(
    company: dict[str, Any],
    linked_investors: list[dict[str, Any]],
) -> dict[str, Any]:
    portfolio_mentions = [
        f"{investor.get('investor_name')}: {investor.get('portfolio_overlap_summary') or investor.get('portfolio_companies')}"
        for investor in linked_investors
        if investor.get("portfolio_companies") or investor.get("portfolio_overlap_summary")
    ]
    if portfolio_mentions:
        summary = "Saved portfolio data can anchor a warm-intro hypothesis: " + "; ".join(portfolio_mentions)
    else:
        summary = "Portfolio overlap is not mapped yet. Research portfolio founders and operators in adjacent sectors."
    return {
        "summary": summary,
        "questions_to_research": [
            f"Which portfolio companies near {company.get('sector') or 'this sector'} could provide a warm context intro?",
            "Which partner appears most connected to this company's funding round or thesis?",
            "Are there platform, talent, or operator contacts who help portfolio companies hire?",
        ],
    }


def build_warm_intro_hypotheses(
    company: dict[str, Any],
    investor_paths: list[dict[str, str]],
    linked_investors: list[dict[str, Any]],
) -> list[dict[str, str]]:
    if not investor_paths:
        return [
            {
                "path": "Company-first research path",
                "why_it_might_work": "A founder or operator conversation may reveal investor context once investor names are missing.",
                "research_needed": "Find funding announcement, founder posts, or Crunchbase investor data.",
            }
        ]

    hypotheses: list[dict[str, str]] = []
    for path in investor_paths[:3]:
        record = find_linked_investor(path["investor_name"], linked_investors)
        contact_path = record.get("contact_path") if record else ""
        relevant_partner = record.get("relevant_partner") if record else ""
        if contact_path:
            research_needed = contact_path
        elif relevant_partner:
            research_needed = f"Validate whether {relevant_partner} led the round or knows the relevant portfolio operators."
        else:
            research_needed = "Find relevant partner, portfolio founder, or operator connection before outreach."
        hypotheses.append(
            {
                "path": f"{path['investor_name']} -> portfolio or partner route",
                "why_it_might_work": path["reason"],
                "research_needed": research_needed,
            }
        )
    return hypotheses


def build_investor_map_outreach_angle(
    company: dict[str, Any],
    strongest_name: str,
    thesis: list[str],
) -> str:
    if company.get("outreach_angle"):
        return company["outreach_angle"]
    if strongest_name:
        return (
            f"Lead with a concise thesis on {company.get('company_name')} in {', '.join(thesis)}, "
            f"then ask for perspective on the company through {strongest_name}'s portfolio lens."
        )
    return (
        f"Lead with curiosity about {company.get('company_name')} and ask who best understands the "
        f"{', '.join(thesis)} investor landscape."
    )


def build_investor_research_steps(
    company: dict[str, Any],
    known_investors: list[str],
    linked_investors: list[dict[str, Any]],
) -> list[str]:
    steps = []
    if known_investors:
        steps.append(f"Confirm which partner at {known_investors[0]} is closest to the round.")
    else:
        steps.append("Find investor names from the funding announcement or Crunchbase export.")
    if linked_investors:
        steps.append("Review saved contact paths and portfolio companies for warm-intro routes.")
        high_priority = [
            investor
            for investor in linked_investors
            if int(investor.get("priority_score") or 0) >= 70
        ]
        if high_priority:
            steps.append(
                f"Prioritize enriched high-score investor profile: {high_priority[0].get('investor_name')}."
            )
    else:
        steps.append("Create investor records for the listed investors and add partner/contact-path notes.")
    if company.get("careers_url"):
        steps.append("Check current roles for platform, talent, operator, or hiring-lead angles.")
    else:
        steps.append("Find a hiring signal before using a recruiting or talent-platform angle.")
    return steps


def build_investor_map_next_action(
    company: dict[str, Any],
    investor_paths: list[dict[str, str]],
) -> str:
    if investor_paths:
        strongest = investor_paths[0]
        return f"Start with {strongest['investor_name']}: {strongest['best_first_step']}"
    if company.get("next_action"):
        return company["next_action"]
    return "Research the funding round and add investor records before outreach."


def build_thesis_fit(
    company: dict[str, Any],
    sector: str,
    total_score: int,
    market_score: int,
    personal_score: int,
) -> dict[str, Any]:
    sector_fit = "direct" if sector.lower() in FOCUS_SECTORS else "adjacent"
    if total_score >= 17:
        priority = "high"
    elif total_score >= 13:
        priority = "medium"
    else:
        priority = "low"

    return {
        "priority": priority,
        "sector_fit": sector_fit,
        "reasoning": (
            f"{company.get('company_name')} sits in {sector or 'an unspecified sector'} with "
            f"a market fit score of {market_score}/5 and personal fit score of {personal_score}/5."
        ),
        "watchouts": "Validate customer traction and role relevance before spending heavy research time.",
    }


def build_investor_path(company: dict[str, Any], investors: str, network_score: int) -> dict[str, Any]:
    if not investors:
        return {
            "summary": "No investor names are saved yet.",
            "path": "Find funding announcement, founder posts, or Crunchbase investor list before outreach.",
            "priority": "research first",
        }

    priority = "strong" if network_score >= 4 else "moderate" if network_score == 3 else "weak"
    return {
        "summary": f"Known investors: {investors}.",
        "path": "Map partners at the lead investor first, then look for portfolio founders or operators who can provide context.",
        "priority": priority,
    }


def build_hiring_signal(company: dict[str, Any], hiring_score: int, has_careers: bool) -> dict[str, Any]:
    if hiring_score >= 4:
        interpretation = "Hiring fit is promising; careers activity may be a useful momentum signal."
    elif hiring_score == 3:
        interpretation = "Hiring fit is plausible but needs validation against current open roles."
    else:
        interpretation = "Hiring fit is weak based on the current score."

    return {
        "score": hiring_score,
        "careers_url": company.get("careers_url"),
        "interpretation": interpretation,
        "next_check": "Review current roles and look for product, operations, growth, or partnerships openings." if has_careers else "Find a careers page or recent hiring posts.",
    }


def build_outreach_angle(
    company: dict[str, Any],
    thesis_fit: dict[str, Any],
    investor_path: dict[str, Any],
) -> str:
    if company.get("outreach_angle"):
        return company["outreach_angle"]

    sector = company.get("sector") or "your market"
    return (
        f"Lead with curiosity about how {company.get('company_name')} is building in {sector}, "
        f"then connect that to the {thesis_fit['priority']} thesis fit and the current investor path: "
        f"{investor_path['priority']}."
    )


def build_smart_questions(company: dict[str, Any], sector: str, has_investors: bool) -> list[str]:
    questions = [
        f"What customer segment is pulling hardest for {company.get('company_name')} right now?",
        f"What is the clearest signal that {sector or 'this market'} is ready for a focused startup approach?",
        "Which role or team is most constrained by current growth?",
    ]
    if has_investors:
        questions.append("How have the current investors helped with customers, hiring, or partnerships?")
    else:
        questions.append("Who are the most relevant investors or advisors around the company today?")
    return questions


def build_next_action(company: dict[str, Any], total_score: int, has_investors: bool) -> str:
    if company.get("next_action"):
        return company["next_action"]
    if total_score >= 16 and has_investors:
        return "Map the lead investor partner and draft a company-specific founder or operator note."
    if total_score >= 13:
        return "Do a 20-minute research pass on traction, roles, and investor connections."
    return "Fill missing company details before prioritizing outreach."


def build_missing_information(company: dict[str, Any]) -> list[str]:
    checks = {
        "website": "Company website",
        "careers_url": "Careers URL",
        "lead_investors": "Lead investors",
        "funding_date": "Funding date",
        "employee_count": "Employee count",
        "notes": "Research notes",
        "outreach_angle": "Outreach angle",
    }
    missing = [label for field, label in checks.items() if not company.get(field)]
    if company.get("data_source") == "Crunchbase CSV" and int(company.get("data_quality_score") or 0) < 5:
        missing.append("Low Crunchbase import data quality")
    for warning in parse_saved_warnings(company.get("data_warnings") or ""):
        if warning not in missing:
            missing.append(warning)
    return missing
