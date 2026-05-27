import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import BriefcaseBusiness from "lucide-react/dist/esm/icons/briefcase-business.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import ClipboardList from "lucide-react/dist/esm/icons/clipboard-list.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Filter from "lucide-react/dist/esm/icons/filter.js";
import Lightbulb from "lucide-react/dist/esm/icons/lightbulb.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import Upload from "lucide-react/dist/esm/icons/upload.js";
import UsersRound from "lucide-react/dist/esm/icons/users-round.js";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8002";
const FETCH_TIMEOUT_MS = 10000;
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
  const [fetchError, setFetchError] = useState("");
  const [loading, setLoading] = useState(true);

  async function fetchJson(path, init) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || `Request failed: ${response.status}`);
      }
      return response.json();
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${path}`);
      }
      if (error instanceof TypeError && error.message === "Failed to fetch") {
        throw new Error(`Failed to fetch ${API_URL}${path}. Check that the backend is running.`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function loadCompanies(nextFilters = filters) {
    const params = new URLSearchParams();
    Object.entries(nextFilters).forEach(([key, value]) => {
      if (value !== "") params.set(key, value);
    });
    const query = params.toString() ? `?${params.toString()}` : "";
    setLoading(true);
    setFetchError("");
    try {
      const [companyData, optionData] = await Promise.all([
        fetchJson(`/companies${query}`),
        fetchJson("/filter-options"),
      ]);
      setCompanies(companyData);
      setOptions(optionData);
    } catch (error) {
      setFetchError(error.message);
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadInvestors() {
    try {
      setInvestors(await fetchJson("/investors"));
    } catch (error) {
      setMessage(error.message);
    }
  }

  useEffect(() => {
    loadCompanies();
  }, []);

  useEffect(() => {
    if (view === "investors" && investors.length === 0) {
      loadInvestors();
    }
  }, [view]);

  const metrics = useMemo(() => {
    const topScore = companies[0]?.total_score || 0;
    const active = companies.filter((company) => !["Passed", "Contacted", "Replied"].includes(company.status)).length;
    return { count: companies.length, topScore, active, investors: investors.length || options.investors.length };
  }, [companies, investors, options.investors]);

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

  async function deleteCompany(companyId) {
    try {
      const deleted = await fetchJson(`/companies/${companyId}`, { method: "DELETE" });
      setCompanies((current) => current.filter((company) => company.id !== companyId));
      setExpandedId(null);
      await loadCompanies();
      if (investors.length > 0) {
        await loadInvestors();
      }
      setMessage(`${deleted.company_name} deleted.`);
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
      return updated;
    } catch (error) {
      setMessage(error.message);
      throw error;
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
      if (investors.length > 0) {
        await loadInvestors();
      }
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
          <button className={view === "week" ? "active" : ""} onClick={() => setView("week")}>
            <ClipboardList size={17} /> This Week
          </button>
          <button className={view === "companies" ? "active" : ""} onClick={() => setView("companies")}>
            <Building2 size={17} /> Companies
          </button>
          <button className={view === "investors" ? "active" : ""} onClick={() => setView("investors")}>
            <UsersRound size={17} /> Investors
          </button>
          <button className={view === "imports" ? "active" : ""} onClick={() => setView("imports")}>
            <Upload size={17} /> Import Center
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
      {fetchError && (
        <div className="notice error-notice">
          <strong>Backend request failed.</strong>
          <span>{fetchError}</span>
          <span>API: {API_URL}</span>
          <button className="icon-button" onClick={() => {
            loadCompanies();
          }}>
            <RefreshCw size={16} /> Retry
          </button>
        </div>
      )}

      {view === "week" ? (
        <ThisWeek fetchJson={fetchJson} setMessage={setMessage} />
      ) : view === "companies" ? (
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
                  onDelete={deleteCompany}
                />
              ))
            )}
          </section>
        </>
      ) : view === "investors" ? (
        <Investors
          investors={investors}
          fetchJson={fetchJson}
          onSave={updateInvestor}
          onRefresh={loadInvestors}
          setMessage={setMessage}
        />
      ) : (
        <ImportCenter fetchJson={fetchJson} onImported={() => {
          loadCompanies();
          if (investors.length > 0) {
            loadInvestors();
          }
        }} />
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

function CompanyRow({ company, expanded, onToggle, onSave, onDelete }) {
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
      {expanded && <CompanyDetail company={company} onSave={onSave} onDelete={onDelete} />}
    </article>
  );
}

function CompanyDetail({ company, onSave, onDelete }) {
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
  const [briefRuns, setBriefRuns] = useState([]);
  const [briefMessage, setBriefMessage] = useState("");
  const [briefLoading, setBriefLoading] = useState(false);
  const [investorMapRuns, setInvestorMapRuns] = useState([]);
  const [investorMapMessage, setInvestorMapMessage] = useState("");
  const [investorMapLoading, setInvestorMapLoading] = useState(false);

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
    loadBriefRuns();
    loadInvestorMapRuns();
  }, [company]);

  const total = Number(form.market_fit_score) + Number(form.personal_fit_score) + Number(form.hiring_fit_score) + Number(form.network_fit_score);

  function change(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function fetchAgentJson(path, init) {
    const response = await fetch(`${API_URL}${path}`, init);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || "Agent request failed");
    }
    return response.json();
  }

  async function loadBriefRuns() {
    try {
      const runs = await fetchAgentJson(`/agents/company-brief/${company.id}/runs`);
      setBriefRuns(runs);
    } catch (error) {
      setBriefMessage(error.message);
    }
  }

  async function loadInvestorMapRuns() {
    try {
      const runs = await fetchAgentJson(`/agents/investor-map/company/${company.id}/runs`);
      setInvestorMapRuns(runs);
    } catch (error) {
      setInvestorMapMessage(error.message);
    }
  }

  async function generateBrief() {
    setBriefLoading(true);
    setBriefMessage("");
    try {
      const run = await fetchAgentJson(`/agents/company-brief/${company.id}`, { method: "POST" });
      setBriefRuns((current) => [run, ...current]);
      setBriefMessage("Networking brief generated.");
    } catch (error) {
      setBriefMessage(error.message);
    } finally {
      setBriefLoading(false);
    }
  }

  async function generateInvestorMap() {
    setInvestorMapLoading(true);
    setInvestorMapMessage("");
    try {
      const run = await fetchAgentJson(`/agents/investor-map/company/${company.id}`, { method: "POST" });
      setInvestorMapRuns((current) => [run, ...current]);
      setInvestorMapMessage("Investor map generated.");
    } catch (error) {
      setInvestorMapMessage(error.message);
    } finally {
      setInvestorMapLoading(false);
    }
  }

  const latestRun = briefRuns[0];
  const latestInvestorMapRun = investorMapRuns[0];

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
          <dt>Open actions</dt>
          <dd>{company.open_action_count ?? 0}</dd>
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
        <div className="detail-actions">
          <button className="primary-button" onClick={() => onSave(company.id, form)}>Save research</button>
          <button
            className="danger-button"
            onClick={() => {
              if (window.confirm(`Delete ${company.company_name}? This also removes saved agent runs for this company.`)) {
                onDelete(company.id);
              }
            }}
          >
            Delete company
          </button>
        </div>
      </section>

      <section className="detail-block wide">
        <div className="section-heading">
          <div>
            <h2>Agent Workflows</h2>
            <p>Deterministic first passes using saved company and investor data.</p>
          </div>
          <div className="agent-actions">
            <button className="primary-button" onClick={generateBrief} disabled={briefLoading}>
              <Lightbulb size={16} />
              {briefLoading ? "Generating..." : "Generate Networking Brief"}
            </button>
            <button className="primary-button" onClick={generateInvestorMap} disabled={investorMapLoading}>
              <UsersRound size={16} />
              {investorMapLoading ? "Mapping..." : "Generate Investor Map"}
            </button>
          </div>
        </div>
        {briefMessage && <p className="inline-notice">{briefMessage}</p>}
        {latestRun ? (
          <BriefCard run={latestRun} />
        ) : (
          <p className="empty compact">No briefs generated for this company yet.</p>
        )}
        {briefRuns.length > 1 && (
          <div className="run-history">
            <h3>Previous Runs</h3>
            {briefRuns.slice(1).map((run) => (
              <details key={run.id}>
                <summary>Run #{run.id} · {formatDate(run.created_at)} · Confidence {run.output_json.confidence_score}%</summary>
                <BriefCard run={run} compact />
              </details>
            ))}
          </div>
        )}
        <div className="agent-subsection">
          <h2>Investor Mapping Agent</h2>
          {investorMapMessage && <p className="inline-notice">{investorMapMessage}</p>}
          {latestInvestorMapRun ? (
            <InvestorMapCard run={latestInvestorMapRun} />
          ) : (
            <p className="empty compact">No investor maps generated for this company yet.</p>
          )}
          {investorMapRuns.length > 1 && (
            <div className="run-history">
              <h3>Previous Investor Maps</h3>
              {investorMapRuns.slice(1).map((run) => (
                <details key={run.id}>
                  <summary>Run #{run.id} · {formatDate(run.created_at)} · Confidence {run.output_json.confidence_score}%</summary>
                  <InvestorMapCard run={run} compact />
                </details>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function InvestorMapCard({ run, compact = false }) {
  const map = run.output_json;
  return (
    <article className={compact ? "brief-card compact" : "brief-card"}>
      <div className="brief-title">
        <UsersRound size={17} />
        <strong>Investor Map Run #{run.id}</strong>
        <span>{formatDate(run.created_at)}</span>
      </div>
      <div className="classification-tags">
        <span>{map.control_tower_classification.company_sector || "Unknown sector"}</span>
        <span>{map.control_tower_classification.stage_signal}</span>
        {map.control_tower_classification.likely_investor_thesis.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <div className="brief-sections">
        <BriefSection title="Investor Summary">
          <p>{map.investor_summary.summary}</p>
          <p><strong>Lead:</strong> {map.investor_summary.lead_investors.join(", ") || "None saved"}</p>
          <p><strong>Other:</strong> {map.investor_summary.other_investors.join(", ") || "None saved"}</p>
        </BriefSection>
        <BriefSection title="Control Tower Classification">
          <p>{map.control_tower_classification.networking_relevance}</p>
          <p>{map.control_tower_classification.stage_signal}</p>
        </BriefSection>
        <BriefSection title="Strongest Investor Paths">
          <div className="relationship-map">
            {map.strongest_investor_paths.length ? (
              map.strongest_investor_paths.map((path) => (
                <div key={path.investor_name} className="relationship-path">
                  <strong>{path.investor_name}</strong>
                  <span>{path.path_strength}</span>
                  <p>{path.reason}</p>
                  <p>{path.best_first_step}</p>
                </div>
              ))
            ) : (
              <p>No investor paths are mapped yet.</p>
            )}
          </div>
        </BriefSection>
        <BriefSection title="Portfolio Overlap Angle">
          <p>{map.portfolio_overlap_angle.summary}</p>
          <ul>
            {map.portfolio_overlap_angle.questions_to_research.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </BriefSection>
        <BriefSection title="Likely Contact Types">
          <ul>
            {map.likely_contact_types.map((type) => (
              <li key={type}>{type}</li>
            ))}
          </ul>
        </BriefSection>
        <BriefSection title="Warm Intro Hypotheses">
          <ul>
            {map.warm_intro_hypotheses.map((hypothesis) => (
              <li key={hypothesis.path}>
                <strong>{hypothesis.path}:</strong> {hypothesis.why_it_might_work} Research: {hypothesis.research_needed}
              </li>
            ))}
          </ul>
        </BriefSection>
        <BriefSection title="Suggested Outreach Angle">
          <p>{map.suggested_outreach_angle}</p>
        </BriefSection>
        <BriefSection title="Research Steps">
          <ul>
            {map.suggested_research_steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </BriefSection>
        <BriefSection title="Recommended Next Action">
          <p>{map.recommended_next_action}</p>
        </BriefSection>
        <BriefSection title="Missing Relationship Data">
          {map.missing_relationship_data.length ? (
            <ul>
              {map.missing_relationship_data.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>No obvious relationship gaps from the saved records.</p>
          )}
        </BriefSection>
        <BriefSection title="Confidence">
          <div className="confidence-meter">
            <span style={{ width: `${map.confidence_score}%` }} />
          </div>
          <p>{map.confidence_score}% based on investor and relationship data completeness.</p>
        </BriefSection>
      </div>
    </article>
  );
}

function BriefCard({ run, compact = false }) {
  const brief = run.output_json;
  return (
    <article className={compact ? "brief-card compact" : "brief-card"}>
      <div className="brief-title">
        <ClipboardList size={17} />
        <strong>Run #{run.id}</strong>
        <span>{formatDate(run.created_at)}</span>
      </div>
      <div className="brief-sections">
        <BriefSection title="Snapshot">
          <dl className="brief-dl">
            <dt>Company</dt>
            <dd>{brief.company_snapshot.company_name}</dd>
            <dt>Sector</dt>
            <dd>{brief.company_snapshot.sector || "Unknown"}</dd>
            <dt>Funding</dt>
            <dd>{brief.company_snapshot.funding.latest_round || "Unknown"} · {brief.company_snapshot.funding.amount || "Amount unknown"}</dd>
            <dt>Status</dt>
            <dd>{brief.company_snapshot.status}</dd>
            <dt>Source</dt>
            <dd>{brief.source_context?.data_source || "Manual / seed data"}</dd>
            <dt>Quality</dt>
            <dd>{brief.source_context?.data_quality_score || 0}/8</dd>
          </dl>
        </BriefSection>
        <BriefSection title="Source Context">
          <p>{brief.source_context?.summary || "Source metadata is not available."}</p>
          {brief.source_context?.data_warnings?.length ? (
            <ul>
              {brief.source_context.data_warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : (
            <p>No source warnings saved.</p>
          )}
        </BriefSection>
        <BriefSection title="Thesis Fit">
          <p><strong>{brief.thesis_fit.priority}</strong> priority · {brief.thesis_fit.sector_fit} sector fit.</p>
          <p>{brief.thesis_fit.reasoning}</p>
        </BriefSection>
        <BriefSection title="Investor Path">
          <p>{brief.investor_networking_path.summary}</p>
          <p>{brief.investor_networking_path.path}</p>
        </BriefSection>
        <BriefSection title="Hiring Signal">
          <p>{brief.hiring_signal.interpretation}</p>
          <p>{brief.hiring_signal.next_check}</p>
        </BriefSection>
        <BriefSection title="Outreach Angle">
          <p>{brief.suggested_outreach_angle}</p>
        </BriefSection>
        <BriefSection title="Smart Questions">
          <ul>
            {brief.smart_questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </BriefSection>
        <BriefSection title="Next Action">
          <p>{brief.recommended_next_action}</p>
        </BriefSection>
        <BriefSection title="Missing Info">
          {brief.missing_information.length ? (
            <ul>
              {brief.missing_information.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>No obvious gaps from the saved record.</p>
          )}
        </BriefSection>
        <BriefSection title="Confidence">
          <div className="confidence-meter">
            <span style={{ width: `${brief.confidence_score}%` }} />
          </div>
          <p>{brief.confidence_score}% based on saved data completeness.</p>
        </BriefSection>
      </div>
    </article>
  );
}

function BriefSection({ title, children }) {
  return (
    <section className="brief-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function formatDate(value) {
  if (!value) return "Unknown date";
  return new Date(value.replace(" ", "T")).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Score({ label, value, onChange }) {
  return (
    <label className="score-input">
      {label}
      <input type="number" min="1" max="5" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

const ACTION_STATUSES = ["New", "Planned", "In Progress", "Waiting", "Done", "Skipped"];
const ACTION_TYPES = [
  "Research Company",
  "Research Investor",
  "Find Partner",
  "Find Contact Path",
  "Check Hiring",
  "Draft Outreach",
  "Send Outreach",
  "Follow Up",
  "Run Company Brief Agent",
  "Run Investor Map Agent",
  "Review Missing Data",
];

function ThisWeek({ fetchJson, setMessage }) {
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    status: "",
    action_type: "",
    target_type: "",
    min_priority: "",
    source: "",
  });

  async function loadActions(nextFilters = filters) {
    const params = new URLSearchParams();
    Object.entries(nextFilters).forEach(([key, value]) => {
      if (value !== "") params.set(key, value);
    });
    const path = params.toString() ? `/actions?${params.toString()}` : "/actions/weekly";
    setLoading(true);
    try {
      setActions(await fetchJson(path));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadActions();
  }, []);

  function updateFilter(key, value) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    loadActions(next);
  }

  async function rebuildQueue() {
    setLoading(true);
    try {
      const result = await fetchJson("/actions/rebuild-weekly", { method: "POST" });
      await loadActions();
      setMessage(`Weekly queue rebuilt: ${result.actions_created} created, ${result.actions_updated} updated.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function updateAction(action, payload) {
    try {
      const updated = await fetchJson(`/actions/${action.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: payload.status ?? action.status,
          due_date: payload.due_date ?? action.due_date ?? "",
          notes: payload.notes ?? action.notes ?? "",
          recommended_action: payload.recommended_action ?? action.recommended_action ?? "",
          outreach_draft: payload.outreach_draft ?? action.outreach_draft ?? "",
        }),
      });
      setActions((current) => current.map((item) => (item.id === action.id ? updated : item)));
      setMessage("Action updated.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function generateDraft(action) {
    try {
      const updated = await fetchJson(`/actions/${action.id}/generate-outreach-draft`, { method: "POST" });
      setActions((current) => current.map((item) => (item.id === action.id ? updated : item)));
      setMessage("Outreach draft generated.");
    } catch (error) {
      setMessage(error.message);
    }
  }

  const metrics = {
    top: actions.filter((action) => Number(action.priority_score || 0) >= 70).length,
    companies: actions.filter((action) => action.target_type === "Company" && action.action_type.includes("Research")).length,
    investors: actions.filter((action) => action.target_type === "Investor" && action.action_type.includes("Research")).length,
    drafts: actions.filter((action) => action.outreach_draft).length,
    missing: actions.filter((action) => action.action_type === "Review Missing Data").length,
    followups: actions.filter((action) => action.action_type === "Follow Up").length,
  };

  return (
    <section className="weekly-dashboard">
      <div className="section-heading">
        <div>
          <h2>This Week</h2>
          <p>Prioritized research and networking actions generated from local company, investor, and agent data.</p>
        </div>
        <button className="primary-button" onClick={rebuildQueue} disabled={loading}>
          <RefreshCw size={16} />
          {loading ? "Rebuilding..." : "Rebuild Weekly Queue"}
        </button>
      </div>

      <div className="weekly-metrics">
        <Metric label="Top Actions" value={metrics.top} icon={<Lightbulb size={18} />} />
        <Metric label="Companies" value={metrics.companies} icon={<Building2 size={18} />} />
        <Metric label="Investors" value={metrics.investors} icon={<UsersRound size={18} />} />
        <Metric label="Drafts Ready" value={metrics.drafts} icon={<ClipboardList size={18} />} />
        <Metric label="Missing Data" value={metrics.missing} icon={<Search size={18} />} />
        <Metric label="Follow-ups" value={metrics.followups} icon={<RefreshCw size={18} />} />
      </div>

      <section className="toolbar">
        <div className="toolbar-title">
          <Filter size={18} />
          <strong>Action Filters</strong>
        </div>
        <select value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}>
          <option value="">Open weekly</option>
          {ACTION_STATUSES.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
        <select value={filters.action_type} onChange={(event) => updateFilter("action_type", event.target.value)}>
          <option value="">Any action</option>
          {ACTION_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
        <select value={filters.target_type} onChange={(event) => updateFilter("target_type", event.target.value)}>
          <option value="">Any target</option>
          <option value="Company">Company</option>
          <option value="Investor">Investor</option>
          <option value="General">General</option>
        </select>
        <select value={filters.min_priority} onChange={(event) => updateFilter("min_priority", event.target.value)}>
          <option value="">Any priority</option>
          {[40, 50, 60, 70, 80].map((score) => (
            <option key={score} value={score}>{score}+</option>
          ))}
        </select>
        <input value={filters.source} onChange={(event) => updateFilter("source", event.target.value)} placeholder="Source" />
      </section>

      <section className="table-wrap weekly-table">
        <div className="action-table-header">
          <span>Priority</span>
          <span>Action</span>
          <span>Target</span>
          <span>Reason</span>
          <span>Recommended</span>
          <span>Status</span>
          <span>Due</span>
        </div>
        {loading ? (
          <p className="empty">Loading actions...</p>
        ) : actions.length === 0 ? (
          <p className="empty">No actions yet. Rebuild the weekly queue to generate priorities.</p>
        ) : (
          actions.map((action) => (
            <ActionRow key={action.id} action={action} onUpdate={updateAction} onGenerateDraft={generateDraft} />
          ))
        )}
      </section>
    </section>
  );
}

function ActionRow({ action, onUpdate, onGenerateDraft }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(action.notes || "");
  const [dueDate, setDueDate] = useState(action.due_date || "");
  const [draft, setDraft] = useState(action.outreach_draft || "");

  useEffect(() => {
    setNotes(action.notes || "");
    setDueDate(action.due_date || "");
    setDraft(action.outreach_draft || "");
  }, [action]);

  return (
    <article className="action-row">
      <button className="action-summary" onClick={() => setOpen(!open)}>
        <span className="score wide-score">{action.priority_score || 0}</span>
        <span>{action.action_type}</span>
        <span>
          <strong>{action.target_name || action.target_type}</strong>
          <small>{action.target_type} · {action.source}</small>
        </span>
        <span>{action.reason}</span>
        <span>{action.recommended_action}</span>
        <span className="status-pill">{action.status}</span>
        <span>{action.due_date || "-"}</span>
      </button>
      <div className="action-row-actions">
        <button className="icon-button" onClick={() => onUpdate(action, { status: "In Progress" })}>In Progress</button>
        <button className="icon-button" onClick={() => onUpdate(action, { status: "Done" })}>Done</button>
        <button className="icon-button" onClick={() => onUpdate(action, { status: "Skipped" })}>Skip</button>
        <button className="icon-button" onClick={() => onGenerateDraft(action)}>Generate Outreach Draft</button>
      </div>
      {open && (
        <div className="action-detail">
          <section className="detail-block">
            <h2>Notes</h2>
            <label>
              Due date
              <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
            </label>
            <label>
              Notes
              <textarea rows="3" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
            <button className="primary-button" onClick={() => onUpdate(action, { notes, due_date: dueDate })}>Save notes</button>
          </section>
          <section className="detail-block">
            <h2>Research Links</h2>
            <div className="research-links">
              {Object.entries(action.research_links || {}).map(([label, href]) => (
                <a key={label} href={href} target="_blank" rel="noreferrer">{label} <ExternalLink size={13} /></a>
              ))}
            </div>
          </section>
          <section className="detail-block wide">
            <h2>Outreach Draft</h2>
            <textarea
              rows="4"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="primary-button" onClick={() => onUpdate(action, { outreach_draft: draft })}>Save draft</button>
          </section>
        </div>
      )}
    </article>
  );
}

const ENRICHMENT_STATUSES = [
  "New",
  "Needs Research",
  "Partially Enriched",
  "Contact Path Found",
  "Ready for Outreach",
  "Contacted",
  "Passed",
];

const RELATIONSHIP_STRENGTHS = ["Unknown", "Cold", "Weak Tie", "Warm Path", "Direct"];

function Investors({ investors, fetchJson, onSave, onRefresh, setMessage }) {
  const [queue, setQueue] = useState([]);
  const [expandedInvestorId, setExpandedInvestorId] = useState(null);
  const [filters, setFilters] = useState({
    minPriority: "",
    status: "",
    thesis: "",
    missingContact: false,
    leadOnly: false,
  });
  const [loading, setLoading] = useState(false);

  async function loadQueue() {
    try {
      setQueue(await fetchJson("/investors/enrichment-queue"));
    } catch (error) {
      setMessage(error.message);
    }
  }

  useEffect(() => {
    loadQueue();
  }, [investors]);

  async function rebuildProfiles() {
    setLoading(true);
    try {
      const result = await fetchJson("/investors/rebuild-profiles", { method: "POST" });
      await onRefresh();
      await loadQueue();
      setMessage(`Investor profiles rebuilt: ${result.investors_created} created, ${result.investors_updated} updated.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function quickStatus(investor, enrichment_status) {
    const updated = await onSave(investor.id, { ...investor, enrichment_status });
    setQueue((current) => current.map((item) => (item.id === investor.id ? { ...item, ...updated } : item)));
  }

  const filteredQueue = queue.filter((investor) => {
    if (filters.minPriority && Number(investor.priority_score || 0) < Number(filters.minPriority)) return false;
    if (filters.status && investor.enrichment_status !== filters.status) return false;
    if (filters.thesis && !(investor.thesis_tags || "").toLowerCase().includes(filters.thesis.toLowerCase())) return false;
    if (filters.missingContact && investor.contact_path && investor.relevant_partner) return false;
    if (filters.leadOnly && Number(investor.lead_investment_count || 0) === 0) return false;
    return true;
  });

  const metrics = {
    total: queue.length || investors.length,
    priority: queue.filter((investor) => Number(investor.priority_score || 0) >= 60).length,
    needsResearch: queue.filter((investor) => ["New", "Needs Research", "Partially Enriched"].includes(investor.enrichment_status)).length,
    contactPath: queue.filter((investor) => investor.contact_path).length,
    ready: queue.filter((investor) => investor.enrichment_status === "Ready for Outreach").length,
  };

  return (
    <section className="enrichment-dashboard">
      <div className="section-heading">
        <div>
          <h2>Investor Enrichment</h2>
          <p>Ranked investor profiles derived from saved company, funding, and fit data.</p>
        </div>
        <button className="primary-button" onClick={rebuildProfiles} disabled={loading}>
          <RefreshCw size={16} />
          {loading ? "Rebuilding..." : "Rebuild Investor Profiles"}
        </button>
      </div>

      <div className="enrichment-metrics">
        <Metric label="Total Investors" value={metrics.total} icon={<UsersRound size={18} />} />
        <Metric label="Priority" value={metrics.priority} icon={<Lightbulb size={18} />} />
        <Metric label="Needs Research" value={metrics.needsResearch} icon={<Search size={18} />} />
        <Metric label="Contact Path" value={metrics.contactPath} icon={<ExternalLink size={18} />} />
        <Metric label="Ready" value={metrics.ready} icon={<BriefcaseBusiness size={18} />} />
      </div>

      <section className="toolbar">
        <div className="toolbar-title">
          <Filter size={18} />
          <strong>Enrichment Filters</strong>
        </div>
        <select value={filters.minPriority} onChange={(event) => setFilters((current) => ({ ...current, minPriority: event.target.value }))}>
          <option value="">Any priority</option>
          {[40, 50, 60, 70, 80].map((score) => (
            <option key={score} value={score}>{score}+</option>
          ))}
        </select>
        <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
          <option value="">Any status</option>
          {ENRICHMENT_STATUSES.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
        <input
          value={filters.thesis}
          onChange={(event) => setFilters((current) => ({ ...current, thesis: event.target.value }))}
          placeholder="Thesis tag"
        />
        <label className="check-filter">
          <input
            type="checkbox"
            checked={filters.missingContact}
            onChange={(event) => setFilters((current) => ({ ...current, missingContact: event.target.checked }))}
          />
          Missing partner/path
        </label>
        <label className="check-filter">
          <input
            type="checkbox"
            checked={filters.leadOnly}
            onChange={(event) => setFilters((current) => ({ ...current, leadOnly: event.target.checked }))}
          />
          Lead investors only
        </label>
      </section>

      <section className="table-wrap enrichment-table">
        <div className="investor-table-header">
          <span>Investor</span>
          <span>Priority</span>
          <span>Tracked</span>
          <span>Lead</span>
          <span>Thesis</span>
          <span>Missing Data</span>
          <span>Status</span>
          <span>Next Action</span>
        </div>
        {filteredQueue.length === 0 ? (
          <p className="empty">No investors match those filters. Rebuild profiles if the queue is empty.</p>
        ) : (
          filteredQueue.map((investor) => (
            <article className="investor-row" key={investor.id}>
              <button className="investor-summary" onClick={() => setExpandedInvestorId(expandedInvestorId === investor.id ? null : investor.id)}>
                <span>
                  <strong>{investor.investor_name}</strong>
                  <small>{investor.canonical_name || investor.display_name}</small>
                </span>
                <span className="score wide-score">{investor.priority_score || 0}</span>
                <span>{investor.tracked_company_count || 0}</span>
                <span>{investor.lead_investment_count || 0}</span>
                <span>{investor.thesis_tags || investor.sector_focus || "-"}</span>
                <span>{(investor.missing_fields || []).slice(0, 3).join(", ") || "None"}</span>
                <span className="status-pill">{investor.enrichment_status || "New"}</span>
                <span>{investor.next_action || investor.recommended_research_task || "-"}</span>
              </button>
              <div className="investor-row-actions">
                <button className="icon-button" onClick={() => setExpandedInvestorId(investor.id)}>Open Detail</button>
                <button className="icon-button" onClick={() => quickStatus(investor, "Needs Research")}>Needs Research</button>
                <button className="icon-button" onClick={() => quickStatus(investor, "Contact Path Found")}>Contact Path Found</button>
                <button className="icon-button" onClick={() => quickStatus(investor, "Ready for Outreach")}>Ready</button>
              </div>
              {expandedInvestorId === investor.id && (
                <InvestorDetail
                  investor={investor}
                  onSave={async (payload) => {
                    const updated = await onSave(investor.id, payload);
                    setQueue((current) => current.map((item) => (item.id === investor.id ? { ...item, ...updated } : item)));
                  }}
                />
              )}
            </article>
          ))
        )}
      </section>
    </section>
  );
}

function InvestorDetail({ investor, onSave }) {
  const [form, setForm] = useState({ ...investor });

  useEffect(() => {
    setForm({ ...investor });
  }, [investor]);

  function change(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const links = investor.research_links || {};

  return (
    <div className="investor-detail-grid">
      <section className="detail-block">
        <h2>Profile</h2>
        <dl>
          <dt>Priority</dt>
          <dd>{investor.priority_score || 0}/100</dd>
          <dt>Stage</dt>
          <dd>{investor.stage_focus || "Unknown"}</dd>
          <dt>Sector</dt>
          <dd>{investor.sector_focus || "Unknown"}</dd>
          <dt>Status</dt>
          <dd>{investor.enrichment_status || "New"}</dd>
        </dl>
        <label>
          Thesis tags
          <input value={form.thesis_tags || ""} onChange={(event) => change("thesis_tags", event.target.value)} />
        </label>
        <label>
          Website
          <input value={form.website || ""} onChange={(event) => change("website", event.target.value)} />
        </label>
        <label>
          LinkedIn URL
          <input value={form.linkedin_url || ""} onChange={(event) => change("linkedin_url", event.target.value)} />
        </label>
        <label>
          Crunchbase URL
          <input value={form.crunchbase_url || ""} onChange={(event) => change("crunchbase_url", event.target.value)} />
        </label>
      </section>

      <section className="detail-block">
        <h2>Portfolio Overlap</h2>
        <p>{investor.portfolio_overlap_summary || "No derived portfolio summary yet."}</p>
        <dl>
          <dt>Tracked</dt>
          <dd>{investor.tracked_company_count || 0}</dd>
          <dt>Lead</dt>
          <dd>{investor.lead_investment_count || 0}</dd>
          <dt>Co</dt>
          <dd>{investor.co_investment_count || 0}</dd>
          <dt>High-fit</dt>
          <dd>{investor.high_fit_company_count || 0}</dd>
          <dt>Avg fit</dt>
          <dd>{investor.average_company_fit_score || 0}</dd>
        </dl>
        <p><strong>Top tracked:</strong> {investor.top_tracked_companies || investor.portfolio_companies || "None yet"}</p>
      </section>

      <section className="detail-block">
        <h2>Networking</h2>
        <label>
          Relevant partner
          <input value={form.relevant_partner || ""} onChange={(event) => change("relevant_partner", event.target.value)} />
        </label>
        <label>
          Partner LinkedIn
          <input value={form.partner_linkedin_url || ""} onChange={(event) => change("partner_linkedin_url", event.target.value)} />
        </label>
        <label>
          Talent / platform contact
          <input value={form.talent_or_platform_contact || ""} onChange={(event) => change("talent_or_platform_contact", event.target.value)} />
        </label>
        <label>
          Contact path
          <textarea rows="2" value={form.contact_path || ""} onChange={(event) => change("contact_path", event.target.value)} />
        </label>
        <label>
          Relationship strength
          <select value={form.relationship_strength || "Unknown"} onChange={(event) => change("relationship_strength", event.target.value)}>
            {RELATIONSHIP_STRENGTHS.map((strength) => (
              <option key={strength} value={strength}>{strength}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="detail-block">
        <h2>Next Enrichment</h2>
        <p>{investor.recommended_research_task || investor.next_action || "Review and add relationship context."}</p>
        <label>
          Enrichment status
          <select value={form.enrichment_status || "New"} onChange={(event) => change("enrichment_status", event.target.value)}>
            {ENRICHMENT_STATUSES.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </label>
        <label>
          Next action
          <input value={form.next_action || ""} onChange={(event) => change("next_action", event.target.value)} />
        </label>
        <label>
          Notes
          <textarea rows="3" value={form.notes || ""} onChange={(event) => change("notes", event.target.value)} />
        </label>
      </section>

      <section className="detail-block">
        <h2>Missing Data</h2>
        <ImportList items={investor.missing_fields || []} empty="No missing fields detected." />
      </section>

      <section className="detail-block">
        <h2>Research Shortcuts</h2>
        <div className="research-links">
          {Object.entries(links).map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer">{label} <ExternalLink size={13} /></a>
          ))}
        </div>
      </section>

      <section className="detail-block wide">
        <button className="primary-button" onClick={() => onSave(form)}>Save investor profile</button>
      </section>
    </div>
  );
}

function ImportCenter({ fetchJson, onImported }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [summary, setSummary] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submitImport(path) {
    if (!file) {
      setMessage("Choose a Crunchbase CSV first.");
      return null;
    }
    const formData = new FormData();
    formData.append("file", file);
    setLoading(true);
    setMessage("");
    try {
      return await fetchJson(path, { method: "POST", body: formData });
    } catch (error) {
      setMessage(error.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function previewImport() {
    const result = await submitImport("/imports/crunchbase/preview");
    if (result) {
      setPreview(result);
      setSummary(null);
      setMessage("Preview ready. Review warnings before confirming.");
    }
  }

  async function confirmImport() {
    const result = await submitImport("/imports/crunchbase/confirm");
    if (result) {
      setSummary(result);
      setMessage("Import complete.");
      onImported();
    }
  }

  return (
    <section className="import-center">
      <div className="detail-block">
        <div className="section-heading">
          <div>
            <h2>Crunchbase CSV Import Center</h2>
            <p>Upload locally, preview mappings and warnings, then confirm import.</p>
          </div>
          <div className="agent-actions">
            <label className="upload-button">
              <Upload size={17} />
              Choose CSV
              <input type="file" accept=".csv" onChange={(event) => {
                setFile(event.target.files?.[0] || null);
                setPreview(null);
                setSummary(null);
                setMessage("");
              }} />
            </label>
            <button className="primary-button" onClick={previewImport} disabled={loading || !file}>
              Preview Import
            </button>
            <button className="primary-button" onClick={confirmImport} disabled={loading || !file || !preview}>
              Confirm Import
            </button>
          </div>
        </div>
        {file && <p className="inline-notice">Selected: {file.name}</p>}
        {message && <p className="inline-notice">{message}</p>}
      </div>

      {preview && <ImportPreview preview={preview} />}
      {summary && <ImportSummary summary={summary} />}
    </section>
  );
}

function ImportPreview({ preview }) {
  return (
    <div className="import-grid">
      <section className="detail-block">
        <h2>Preview Summary</h2>
        <div className="import-metrics">
          <Metric label="Rows" value={preview.row_count} icon={<Upload size={18} />} />
          <Metric label="Columns" value={preview.detected_columns.length} icon={<ClipboardList size={18} />} />
          <Metric label="New Investors" value={preview.investors_to_create.length} icon={<UsersRound size={18} />} />
        </div>
      </section>
      <section className="detail-block">
        <h2>Detected Columns</h2>
        <div className="classification-tags">
          {preview.detected_columns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
      </section>
      <section className="detail-block">
        <h2>Proposed Field Mapping</h2>
        <dl className="import-mapping">
          {Object.entries(preview.proposed_field_mapping).map(([source, target]) => (
            <React.Fragment key={source}>
              <dt>{source}</dt>
              <dd>{target}</dd>
            </React.Fragment>
          ))}
        </dl>
      </section>
      <section className="detail-block">
        <h2>Warnings</h2>
        <ImportList items={preview.missing_recommended_columns.map((column) => `Missing recommended column: ${column}`)} empty="No recommended columns missing." />
        <ImportList items={preview.duplicate_existing_companies.map((name) => `Existing company will update: ${name}`)} empty="No existing company duplicates." />
        <ImportList items={preview.duplicate_csv_companies.map((name) => `Duplicate inside CSV: ${name}`)} empty="No duplicate company names inside CSV." />
      </section>
      <section className="detail-block wide">
        <h2>First 10 Rows</h2>
        <div className="preview-table">
          <div className="preview-row header">
            <span>Row</span>
            <span>Company</span>
            <span>Sector</span>
            <span>Funding</span>
            <span>Investors</span>
            <span>Quality</span>
          </div>
          {preview.preview_rows.map((row) => (
            <div className="preview-row" key={row.row_number}>
              <span>{row.row_number}</span>
              <span>{row.company_name || "Missing name"}</span>
              <span>{row.sector || "-"}</span>
              <span>{[row.latest_funding_round, row.funding_amount, row.funding_date].filter(Boolean).join(" · ") || "-"}</span>
              <span>{[row.lead_investors, row.other_investors].filter(Boolean).join(", ") || "-"}</span>
              <span>{row.data_quality_score}/8</span>
            </div>
          ))}
        </div>
      </section>
      <section className="detail-block">
        <h2>Investors To Create</h2>
        <ImportList items={preview.investors_to_create} empty="No new investor records detected." />
      </section>
      <section className="detail-block">
        <h2>Row-Level Warnings</h2>
        <ImportList
          items={preview.warnings.slice(0, 30).map((warning) => `Row ${warning.row}: ${warning.company_name || "Unknown"} - ${warning.warnings.join(", ")}`)}
          empty="No row-level warnings."
        />
      </section>
    </div>
  );
}

function ImportSummary({ summary }) {
  return (
    <section className="detail-block">
      <h2>Import Summary</h2>
      <div className="import-metrics">
        <Metric label="Created" value={summary.companies_created} icon={<Building2 size={18} />} />
        <Metric label="Updated" value={summary.companies_updated} icon={<RefreshCw size={18} />} />
        <Metric label="Investors +" value={summary.investors_created} icon={<UsersRound size={18} />} />
        <Metric label="Investors Updated" value={summary.investors_updated} icon={<UsersRound size={18} />} />
        <Metric label="Skipped" value={summary.rows_skipped} icon={<Filter size={18} />} />
      </div>
      <ImportList
        items={summary.warnings.slice(0, 40).map((warning) => `Row ${warning.row || "-"}: ${warning.company_name || ""} ${warning.warnings.join(", ")}`)}
        empty="No import warnings."
      />
    </section>
  );
}

function ImportList({ items, empty }) {
  if (!items.length) return <p className="empty compact">{empty}</p>;
  return (
    <ul className="import-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

createRoot(document.getElementById("root")).render(<App />);
