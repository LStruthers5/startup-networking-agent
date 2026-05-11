import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BriefcaseBusiness,
  Building2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Filter,
  RefreshCw,
  Search,
  Upload,
  UsersRound,
} from "lucide-react";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
const STATUSES = [
  "New",
  "Researching",
  "Investor Mapped",
  "Outreach Drafted",
  "Contacted",
  "Replied",
  "Passed",
];

function App() {
  const [view, setView] = useState("companies");
  const [companies, setCompanies] = useState([]);
  const [investors, setInvestors] = useState([]);
  const [options, setOptions] = useState({ sectors: [], statuses: [], funding_rounds: [], investors: [] });
  const [filters, setFilters] = useState({
    sector: "",
    location: "",
    status: "",
    min_score: "",
    funding_round: "",
    investor: "",
  });
  const [expandedId, setExpandedId] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function fetchJson(path, init) {
    const response = await fetch(`${API_URL}${path}`, init);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || "Request failed");
    }
    return response.json();
  }

  async function loadCompanies(nextFilters = filters) {
    const params = new URLSearchParams();
    Object.entries(nextFilters).forEach(([key, value]) => {
      if (value !== "") params.set(key, value);
    });
    const query = params.toString() ? `?${params.toString()}` : "";
    setLoading(true);
    try {
      const [companyData, optionData] = await Promise.all([
        fetchJson(`/api/companies${query}`),
        fetchJson("/api/filter-options"),
      ]);
      setCompanies(companyData);
      setOptions(optionData);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadInvestors() {
    try {
      setInvestors(await fetchJson("/api/investors"));
    } catch (error) {
      setMessage(error.message);
    }
  }

  useEffect(() => {
    loadCompanies();
    loadInvestors();
  }, []);

  const metrics = useMemo(() => {
    const topScore = companies[0]?.total_score || 0;
    const active = companies.filter((company) => !["Passed", "Contacted", "Replied"].includes(company.status)).length;
    return { count: companies.length, topScore, active, investors: investors.length };
  }, [companies, investors]);

  function updateFilter(key, value) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    loadCompanies(next);
  }

  async function updateCompany(companyId, payload) {
    try {
      const updated = await fetchJson(`/api/companies/${companyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setCompanies((current) => current.map((company) => (company.id === companyId ? updated : company)));
      setMessage("Company research fields saved.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function updateInvestor(investorId, payload) {
    try {
      const updated = await fetchJson(`/api/investors/${investorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setInvestors((current) => current.map((investor) => (investor.id === investorId ? updated : investor)));
      setMessage("Investor notes saved.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const result = await fetchJson("/api/import/companies", {
        method: "POST",
        body: formData,
      });
      await loadCompanies();
      await loadInvestors();
      setMessage(`CSV imported: ${result.imported} new, ${result.updated} updated, ${result.skipped.length} skipped.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      event.target.value = "";
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local MVP</p>
          <h1>Startup Networking Tracker</h1>
        </div>
        <nav className="view-tabs" aria-label="Primary">
          <button className={view === "companies" ? "active" : ""} onClick={() => setView("companies")}>
            <Building2 size={17} /> Companies
          </button>
          <button className={view === "investors" ? "active" : ""} onClick={() => setView("investors")}>
            <UsersRound size={17} /> Investors
          </button>
        </nav>
      </header>

      <section className="metric-grid">
        <Metric label="Companies" value={metrics.count} icon={<Building2 size={18} />} />
        <Metric label="Top score" value={metrics.topScore} icon={<Search size={18} />} />
        <Metric label="Active leads" value={metrics.active} icon={<BriefcaseBusiness size={18} />} />
        <Metric label="Investors" value={metrics.investors} icon={<UsersRound size={18} />} />
      </section>

      {message && <div className="notice">{message}</div>}

      {view === "companies" ? (
        <>
          <section className="toolbar">
            <div className="toolbar-title">
              <Filter size={18} />
              <strong>Filters</strong>
            </div>
            <select value={filters.sector} onChange={(event) => updateFilter("sector", event.target.value)}>
              <option value="">All sectors</option>
              {options.sectors.map((sector) => (
                <option key={sector} value={sector}>{sector}</option>
              ))}
            </select>
            <input
              value={filters.location}
              onChange={(event) => updateFilter("location", event.target.value)}
              placeholder="Location"
            />
            <select value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
            <select value={filters.min_score} onChange={(event) => updateFilter("min_score", event.target.value)}>
              <option value="">Any score</option>
              {[8, 10, 12, 14, 16, 18].map((score) => (
                <option key={score} value={score}>{score}+</option>
              ))}
            </select>
            <select value={filters.funding_round} onChange={(event) => updateFilter("funding_round", event.target.value)}>
              <option value="">All rounds</option>
              {options.funding_rounds.map((round) => (
                <option key={round} value={round}>{round}</option>
              ))}
            </select>
            <input
              value={filters.investor}
              onChange={(event) => updateFilter("investor", event.target.value)}
              placeholder="Investor name"
              list="investor-options"
            />
            <datalist id="investor-options">
              {options.investors.map((investor) => (
                <option key={investor} value={investor} />
              ))}
            </datalist>
            <button className="icon-button" onClick={() => loadCompanies()} title="Refresh companies">
              <RefreshCw size={17} />
            </button>
            <label className="upload-button">
              <Upload size={17} />
              Import CSV
              <input type="file" accept=".csv" onChange={handleImport} />
            </label>
          </section>

          <section className="table-wrap">
            <div className="table-header">
              <span>Company</span>
              <span>Sector</span>
              <span>Momentum</span>
              <span>Status</span>
              <span>Score</span>
            </div>
            {loading ? (
              <p className="empty">Loading companies...</p>
            ) : companies.length === 0 ? (
              <p className="empty">No companies match those filters.</p>
            ) : (
              companies.map((company) => (
                <CompanyRow
                  key={company.id}
                  company={company}
                  expanded={expandedId === company.id}
                  onToggle={() => setExpandedId(expandedId === company.id ? null : company.id)}
                  onSave={updateCompany}
                />
              ))
            )}
          </section>
        </>
      ) : (
        <Investors investors={investors} onSave={updateInvestor} />
      )}
    </main>
  );
}

function Metric({ label, value, icon }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CompanyRow({ company, expanded, onToggle, onSave }) {
  return (
    <article className="company-row">
      <button className="company-summary" onClick={onToggle}>
        <span className="chevron">{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
        <span>
          <strong>{company.company_name}</strong>
          <small>{company.location}</small>
        </span>
        <span>{company.sector}</span>
        <span>
          <strong>{company.latest_funding_round || "Unknown"}</strong>
          <small>{company.funding_amount} {company.funding_date}</small>
        </span>
        <span className="status-pill">{company.status}</span>
        <span className="score">{company.total_score}</span>
      </button>
      {expanded && <CompanyDetail company={company} onSave={onSave} />}
    </article>
  );
}

function CompanyDetail({ company, onSave }) {
  const [form, setForm] = useState({
    market_fit_score: company.market_fit_score,
    personal_fit_score: company.personal_fit_score,
    hiring_fit_score: company.hiring_fit_score,
    network_fit_score: company.network_fit_score,
    status: company.status,
    notes: company.notes || "",
    next_action: company.next_action || "",
    outreach_angle: company.outreach_angle || "",
  });

  useEffect(() => {
    setForm({
      market_fit_score: company.market_fit_score,
      personal_fit_score: company.personal_fit_score,
      hiring_fit_score: company.hiring_fit_score,
      network_fit_score: company.network_fit_score,
      status: company.status,
      notes: company.notes || "",
      next_action: company.next_action || "",
      outreach_angle: company.outreach_angle || "",
    });
  }, [company]);

  const total = Number(form.market_fit_score) + Number(form.personal_fit_score) + Number(form.hiring_fit_score) + Number(form.network_fit_score);

  function change(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="detail-grid">
      <section className="detail-block">
        <h2>Summary</h2>
        <p>{company.description || "No description yet."}</p>
        <div className="link-row">
          {company.website && <a href={company.website} target="_blank" rel="noreferrer">Website <ExternalLink size={14} /></a>}
          {company.crunchbase_url && <a href={company.crunchbase_url} target="_blank" rel="noreferrer">Crunchbase <ExternalLink size={14} /></a>}
          {company.careers_url && <a href={company.careers_url} target="_blank" rel="noreferrer">Careers <ExternalLink size={14} /></a>}
        </div>
        <dl>
          <dt>Funding</dt>
          <dd>{company.latest_funding_round || "Unknown"} · {company.funding_amount || "Amount unknown"} · {company.funding_date || "Date unknown"}</dd>
          <dt>Investors</dt>
          <dd>{[company.lead_investors, company.other_investors].filter(Boolean).join(", ") || "No investors listed"}</dd>
          <dt>Employees</dt>
          <dd>{company.employee_count || "Unknown"}</dd>
        </dl>
      </section>

      <section className="detail-block">
        <h2>Research</h2>
        <div className="score-grid">
          <Score label="Market" value={form.market_fit_score} onChange={(value) => change("market_fit_score", value)} />
          <Score label="Personal" value={form.personal_fit_score} onChange={(value) => change("personal_fit_score", value)} />
          <Score label="Hiring" value={form.hiring_fit_score} onChange={(value) => change("hiring_fit_score", value)} />
          <Score label="Network" value={form.network_fit_score} onChange={(value) => change("network_fit_score", value)} />
          <div className="total-box">
            <span>Total</span>
            <strong>{total}</strong>
          </div>
        </div>
        <label>
          Status
          <select value={form.status} onChange={(event) => change("status", event.target.value)}>
            {STATUSES.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="detail-block wide">
        <h2>Next Move</h2>
        <label>
          Notes
          <textarea value={form.notes} onChange={(event) => change("notes", event.target.value)} rows="4" />
        </label>
        <label>
          Next action
          <input value={form.next_action} onChange={(event) => change("next_action", event.target.value)} />
        </label>
        <label>
          Outreach angle
          <textarea value={form.outreach_angle} onChange={(event) => change("outreach_angle", event.target.value)} rows="3" />
        </label>
        <button className="primary-button" onClick={() => onSave(company.id, form)}>Save research</button>
      </section>
    </div>
  );
}

function Score({ label, value, onChange }) {
  return (
    <label className="score-input">
      {label}
      <input type="number" min="1" max="5" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Investors({ investors, onSave }) {
  return (
    <section className="investor-grid">
      {investors.map((investor) => (
        <InvestorCard key={investor.id} investor={investor} onSave={onSave} />
      ))}
    </section>
  );
}

function InvestorCard({ investor, onSave }) {
  const [form, setForm] = useState({ ...investor });

  useEffect(() => {
    setForm({ ...investor });
  }, [investor]);

  function change(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <article className="investor-card">
      <div className="investor-card-header">
        <input value={form.investor_name} onChange={(event) => change("investor_name", event.target.value)} />
        <label>
          Priority
          <input type="number" min="1" max="5" value={form.priority_score} onChange={(event) => change("priority_score", Number(event.target.value))} />
        </label>
      </div>
      <label>
        Thesis tags
        <input value={form.thesis_tags || ""} onChange={(event) => change("thesis_tags", event.target.value)} />
      </label>
      <label>
        Portfolio companies
        <textarea rows="2" value={form.portfolio_companies || ""} onChange={(event) => change("portfolio_companies", event.target.value)} />
      </label>
      <label>
        Relevant partner
        <input value={form.relevant_partner || ""} onChange={(event) => change("relevant_partner", event.target.value)} />
      </label>
      <label>
        Contact path
        <textarea rows="2" value={form.contact_path || ""} onChange={(event) => change("contact_path", event.target.value)} />
      </label>
      <label>
        Notes
        <textarea rows="3" value={form.notes || ""} onChange={(event) => change("notes", event.target.value)} />
      </label>
      <button className="primary-button" onClick={() => onSave(investor.id, form)}>Save investor</button>
    </article>
  );
}

createRoot(document.getElementById("root")).render(<App />);
