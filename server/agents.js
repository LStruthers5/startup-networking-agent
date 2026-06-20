const MODEL = 'claude-sonnet-4-6';
const { trackedAnthropicClient, trackedExaSearch, executeAgent, currentRun } = require('./agent-control');

function getClient() {
  return trackedAnthropicClient();
}

async function buildContactsBlock() {
  const { query } = require('./db');
  const contacts = await query('SELECT * FROM contacts ORDER BY firm, name');
  if (!contacts.length) return '';
  const lines = contacts.map(c => {
    const label = c.name ? `${c.name} (${c.firm})` : c.firm;
    const rel = c.how_i_know_them || 'known contact';
    const extras = [c.role, c.sector_focus, c.stage_focus].filter(Boolean).join(', ');
    return `- ${label} — ${rel}${extras ? ` [${extras}]` : ''}`;
  }).join('\n');
  return `\nHere are people I have direct relationships with:\n${lines}\n\nWhere possible, prioritize these people or use them as explicit intro paths over generic network suggestions.`;
}

// Search Exa for accessible people at a specific VC firm
async function searchFirmForPeople(firmName) {
  const EXA_KEY = process.env.EXA_API_KEY;
  if (!EXA_KEY) return null;
  try {
    // Two passes: firm's own site (team page) + general web (LinkedIn profiles, articles)
    const query = `"${firmName}" venture capital team associate analyst scout principal "venture partner"`;
    const data = await trackedExaSearch({ query, num_results: 5, text: { maxCharacters: 800 } });
    const results = data.results || [];
    return results.map(r => `[${r.title}](${r.url})\n${r.text || ''}`).join('\n---\n');
  } catch (_) {
    return null;
  }
}

// Claude batch-extracts accessible people from Exa results for multiple firms
async function extractAccessiblePeopleFromFirms(firmsWithResults) {
  const client = getClient();

  const blocks = firmsWithResults.map(({ firm, text }) =>
    `FIRM: ${firm}\n${text || '(no search results)'}`
  ).join('\n\n===\n\n');

  const prompt = `You are a VC researcher sourcing accessible investor contacts. For each firm below, extract real people with roles that are MOST LIKELY to respond to a cold email.

PRIORITY ORDER (highest response rate first):
1. Scout / Venture Scout — actively hunting deals, highest motivation to talk
2. Analyst / Associate / Senior Associate — proving themselves, want deal flow
3. EIR / Entrepreneur-in-Residence / Venture Partner / Operating Partner
4. Principal / VP / Vice President
5. Partner at funds under $300M AUM

SKIP entirely: General Partner, Managing Partner, Founding Partner, Fund Manager at Tier-1 firms (Sequoia, a16z, Benchmark, Kleiner Perkins, Greylock). They rarely respond cold.

Return ONLY a valid JSON object, no other text:
{
  "Firm Name": [
    { "name": "Jane Smith", "role": "Associate", "tier": 2 },
    ...
  ]
}

If a firm has no qualifying people, return an empty array for that key.

FIRMS:
${blocks}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const raw = msg.content[0].text.trim();
    const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] || '{}';
    return JSON.parse(jsonStr);
  } catch (_) {
    return {};
  }
}

// Verify a single investor name+firm via Exa
async function verifyInvestorViaExa(name, firm) {
  const EXA_KEY = process.env.EXA_API_KEY;
  if (!EXA_KEY) return { confirmed: null, url: null }; // null = couldn't check

  try {
    const query = `"${name}" "${firm}" venture capital investor`;
    const data = await trackedExaSearch({ query, num_results: 3, text: { maxCharacters: 400 } });
    const results = data.results || [];
    const nameLower = name.toLowerCase();
    const firmLower = firm.toLowerCase();
    const match = results.find(r => {
      const blob = `${r.title} ${r.url} ${r.text || ''}`.toLowerCase();
      return blob.includes(nameLower) && blob.includes(firmLower);
    });
    return {
      confirmed: !!match,
      url: match ? match.url : (results[0] ? results[0].url : null),
    };
  } catch (_) {
    return { confirmed: null, url: null };
  }
}

// ─── FIRM DISCOVERY ────────────────────────────────────────────────────────
// Finds accessible individuals at a specific VC firm relevant to your pipeline
async function runFirmDiscovery(firmName, pipelineCompanies) {
  // Reuse the existing Exa + Claude pipeline
  const searchText = await searchFirmForPeople(firmName);
  const peopleByFirm = await extractAccessiblePeopleFromFirms([{ firm: firmName, text: searchText }]);

  // extractAccessiblePeopleFromFirms keys by firm name as Claude interprets it — try exact, then fuzzy
  const people =
    peopleByFirm[firmName] ||
    Object.entries(peopleByFirm).find(([k]) =>
      k.toLowerCase().includes(firmName.toLowerCase()) ||
      firmName.toLowerCase().includes(k.toLowerCase())
    )?.[1] ||
    Object.values(peopleByFirm)[0] ||
    [];

  return people.filter(p => p.name).map(p => ({
    name: p.name,
    firm: firmName,
    role: p.role || '',
    tier: p.tier || 5,
    source: 'agent',
    confirmed: 0,
  }));
}

async function runBrief(company, networkContext) {
  const client = getClient();
  const prompt = `You are an action-oriented venture research assistant. Given the company details below, produce a structured company brief in EXACTLY this format — no extra sections, no deviation:

SECTION 1 — What They Do
[2-3 sentences max describing the core product/service]

SECTION 2 — Why It Matters To My Network
- Sector fit: [which focus sector — AI, fitness/wearables, or clean tech — and why]
- Angle: [what makes this specifically interesting right now]

SECTION 3 — Who To Contact
- Role: [specific title to target, e.g. founder, CTO, BD lead]
- Why: [1 sentence on why that role specifically]

SECTION 4 — What To Say
- Core message: [3-sentence outreach angle — not a draft email, just the core message]
- What I bring: [what value the researcher brings to this company]

SECTION 5 — Next Action
- Action: [one specific recommended action]
- Timeline: [suggested timeframe, e.g. "this week", "within 2 weeks"]

---
COMPANY DATA:
Name: ${company.name}
Sector: ${company.sector}
Stage: ${company.stage || 'unknown'}
Description: ${company.description || 'not provided'}
Last Funding: ${company.last_funding || 'unknown'} — ${company.funding_amount || 'amount unknown'}
Location: ${company.location || 'unknown'}
Notes: ${company.notes || 'none'}

RESEARCHER NETWORK CONTEXT:
${networkContext || 'No network context provided.'}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

async function runInvestorMap(company, networkContext) {
  const client = getClient();
  const { query } = require('./db');

  // Pull user's saved investors — these are pre-verified, highest trust
  const savedInvestors = await query('SELECT * FROM investors ORDER BY firm, name');
  const savedBlock = savedInvestors.length
    ? 'USER SAVED INVESTORS (pre-verified, prioritize these):\n' +
      savedInvestors.map(i =>
        `- ${i.name} | ${i.firm || '—'} | ${i.role || '—'} | Stage: ${i.stage_focus || '?'} | Sector: ${i.sector_focus || '?'}`
      ).join('\n')
    : '';

  // STEP 1: Claude freely generates investor candidates as JSON
  const generationPrompt = `You are a venture investor sourcing assistant. Given the company below, suggest up to 6 investors who would be a strong fit.

You are sourcing NEW leads — suggest real investors you know exist in the venture ecosystem, including people the researcher may not already know. Focus on realistic accessibility (prefer scouts, associates, principals, and smaller fund partners over top-tier GPs).

Output ONLY a JSON array — no other text before or after. Each item must have:
  name, firm, role, stage_fit, sector_fit, accessibility ("High"/"Medium"/"Low"), accessibility_reason

Example format:
[
  {
    "name": "Jane Smith",
    "firm": "Acme Ventures",
    "role": "Principal",
    "stage_fit": "Leads seed rounds in AI",
    "sector_fit": "Portfolio includes 3 AI health companies",
    "accessibility": "High",
    "accessibility_reason": "Principal-level, active on LinkedIn and Twitter"
  }
]

${savedBlock ? savedBlock + '\n\nAlso suggest investors BEYOND this list — the goal is to find new leads.\n' : ''}

COMPANY:
Name: ${company.name}
Sector: ${company.sector}
Stage: ${company.stage || 'unknown'}
Description: ${company.description || 'not provided'}
Last Funding: ${company.last_funding || 'unknown'} — ${company.funding_amount || 'amount unknown'}
Location: ${company.location || 'unknown'}`;

  const genMsg = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: generationPrompt }],
  });

  // Parse the JSON candidates
  let candidates = [];
  try {
    const raw = genMsg.content[0].text.trim();
    const jsonStr = raw.match(/\[[\s\S]*\]/)?.[0] || raw;
    candidates = JSON.parse(jsonStr);
  } catch (_) {
    candidates = [];
  }

  // Mark saved investors — they skip Exa verification (already trusted)
  const savedNames = new Set(savedInvestors.map(i => i.name.toLowerCase()));
  candidates = candidates.map(c => ({
    ...c,
    isSaved: savedNames.has((c.name || '').toLowerCase()),
  }));

  // STEP 2: Exa verification — run in parallel for non-saved candidates
  const toVerify = candidates.filter(c => !c.isSaved);
  const verifications = await Promise.all(
    toVerify.map(c => verifyInvestorViaExa(c.name, c.firm))
  );
  toVerify.forEach((c, i) => { c.verification = verifications[i]; });
  candidates.filter(c => c.isSaved).forEach(c => {
    c.verification = { confirmed: true, url: null };
  });

  // STEP 3: Claude formats the final output using verified data
  const verifiedList = candidates.map((c, i) => {
    const v = c.verification || {};
    let badge;
    if (c.isSaved) badge = '✦ SAVED';
    else if (v.confirmed === true) badge = '✓ VERIFIED';
    else if (v.confirmed === false) badge = '⚠ UNVERIFIED — confirm before reaching out';
    else badge = '? UNVERIFIED (no Exa key — confirm manually)';
    return `${i + 1}. ${c.name} | ${c.firm} | ${c.role} [${badge}]${v.url ? `\n   Source: ${v.url}` : ''}
   Stage fit: ${c.stage_fit}
   Sector fit: ${c.sector_fit}
   Accessibility: ${c.accessibility} — ${c.accessibility_reason}`;
  }).join('\n\n');

  const formattingPrompt = `You are a venture research assistant. Format the investor mapping output below using EXACTLY this structure:

SECTION 1 — Investor Fit List
${verifiedList || 'No candidates were generated.'}

SECTION 2 — Warm Intro Paths
For each investor above, reason about who in the researcher's network could connect them. Be specific about WHY a given contact is likely to know that investor (firm overlap, sector, geography, co-investments).

SECTION 3 — Next Steps
- Which verified investors should be prioritized and why?
- For any marked ⚠ UNVERIFIED: suggest specific ways to confirm (LinkedIn, firm website, Crunchbase)

---
COMPANY: ${company.name} | ${company.sector} | ${company.stage || 'unknown stage'}

RESEARCHER NETWORK CONTEXT:
${networkContext || 'No network context provided.'}
${await buildContactsBlock()}`;

  const finalMsg = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: formattingPrompt }],
  });

  return finalMsg.content[0].text;
}

async function runExtractPortfolio(investor, searchText) {
  const client = getClient();
  const prompt = `You are a research assistant. Given raw search result text about an investor, extract a clean list of company names they have invested in or are known to back.

Output ONLY company names, one per line. No bullet points, no numbers, no descriptions, no extra text. If you find nothing credible, output the single word: NONE

Investor: ${investor.name ? `${investor.name} at ${investor.firm}` : investor.firm}
${investor.sector_focus ? `Known sector focus: ${investor.sector_focus}` : ''}
${investor.stage_focus ? `Known stage focus: ${investor.stage_focus}` : ''}

SEARCH RESULTS:
${searchText}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text.trim();
}

async function runDailyOutreachSuggestions(companies, overdueFollowUps = []) {
  const client = getClient();
  const { query } = require('./db');

  const contacts = await query('SELECT * FROM contacts ORDER BY firm, name');
  const contactCount = contacts.filter(c => c.name).length;

  const contactsBlock = contacts.length
    ? 'WARM CONNECTIONS:\n' +
      contacts.map(c => {
        const label = c.name ? `${c.name} (${c.firm})` : c.firm;
        return `- ${label} — ${c.how_i_know_them || 'known contact'}`;
      }).join('\n')
    : '';

  const overdueBlock = overdueFollowUps.length
    ? `⚠ FOLLOW-UPS DUE TODAY:\n` +
      overdueFollowUps.map(a =>
        `- ${a.company_name}: "${a.suggested_action}" (Step ${a.sequence_step}/3, due ${a.due_date})`
      ).join('\n') + '\n\n'
    : '';

  // Use shared pipeline: firm names → Exa → accessible people
  const { companyFirmMap, peopleByFirm } = await gatherInvestorDataForCompanies(companies);

  // --- STEP 4: Build per-company investor context ---
  const companySections = companies.map(c => {
    const firms = companyFirmMap[c.id] || [];
    const peopleLines = firms.map(firm => {
      const people = peopleByFirm[firm] || [];
      if (!people.length) return `  ${firm}: (no accessible contacts found via search)`;
      return `  ${firm}:\n` +
        people.slice(0, 3).map(p =>
          `    • ${p.name} | ${p.role} [Tier ${p.tier || '?'} — ${tierLabel(p.tier)}]`
        ).join('\n');
    }).join('\n');

    return `COMPANY: ${c.name} | ${c.sector} | ${c.stage || 'unknown stage'}
Description: ${c.description || 'not provided'}
CONFIRMED INVESTOR FIRMS (from Crunchbase):
${firms.length ? peopleLines : '  (no investor firm data — use best judgment)'}`;
  }).join('\n\n---\n\n');

  // Warm path instruction adapts to network maturity
  const warmInstruction = contactCount >= 3
    ? `WARM PATH RULE: For each company, slot 1 must be a warm path — pick one of the confirmed investor firms and reason whether any of my contacts could introduce me. Be specific: co-investment history, sector overlap, same geography. If no credible link exists, say "No clear warm path yet — cold approach recommended."`
    : contactCount >= 1
    ? `WARM PATH RULE: Try to find 1 warm angle per company. If uncertain, flag it "Potential warm path — verify first."`
    : `NETWORK STAGE: All slots are cold outreach. Prioritize Tier 1-2 people (scouts + associates).`;

  // --- STEP 5: Claude writes the final email ---
  const prompt = `You are a venture networking coach helping a researcher find a job at early-stage AI, fitness/wearables, and clean tech startups.

For each company below, I've already identified the ACTUAL investor firms (from Crunchbase data) and searched for accessible people at those firms. Use ONLY the people listed — do not invent new names. If a firm shows no people found, you may note that and suggest checking their website directly.

${warmInstruction}

Format EXACTLY as (repeat for each company):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[COMPANY NAME] · [Sector] · [Stage]
[2-sentence overview]
Timing: [why reach out now — 1 sentence]

🔗 WARM PATH
→ [Name] | [Firm] | [Role]
   Via: [contact name + specific reason they'd know this person]
   Angle: [1-sentence outreach hook]

📡 COLD OUTREACH
→ [Name] | [Firm] | [Role] · [Accessibility tier]
   Angle: [specific, non-generic 1-sentence hook]

→ [Name] | [Firm] | [Role] · [Accessibility tier]
   Angle: [specific, non-generic 1-sentence hook]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${overdueBlock}COMPANIES WITH CONFIRMED INVESTOR DATA:
${companySections}

${contactsBlock}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1800,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

function tierLabel(tier) {
  const labels = { 1: 'Scout', 2: 'Associate/Analyst', 3: 'EIR/Venture Partner', 4: 'Principal/VP', 5: 'Partner' };
  return labels[tier] || 'Investor';
}

// ─── SHARED PIPELINE: firm names → Exa → people ───────────────────────────
// Used by both the daily email and the queue suggestions feed
async function gatherInvestorDataForCompanies(companies) {
  const companyFirmMap = {};
  const allFirms = new Set();

  for (const c of companies) {
    const firms = (c.investor_firms || '')
      .split(',').map(f => f.trim()).filter(f => f.length > 1).slice(0, 3);
    companyFirmMap[c.id] = firms;
    firms.forEach(f => allFirms.add(f));
  }

  const firmArray = [...allFirms];
  if (!firmArray.length) return { companyFirmMap, peopleByFirm: {} };

  const searchResults = await Promise.all(firmArray.map(f => searchFirmForPeople(f)));
  const firmsWithResults = firmArray.map((firm, i) => ({ firm, text: searchResults[i] }));
  const peopleByFirm = await extractAccessiblePeopleFromFirms(firmsWithResults);

  return { companyFirmMap, peopleByFirm };
}

// ─── QUEUE SUGGESTIONS: returns JSON cards ─────────────────────────────────
async function runQueueSuggestions(companies) {
  const client = getClient();
  const { query, queryOne } = require('./db');
  const contacts = await query("SELECT * FROM contacts WHERE name != '' ORDER BY firm");
  const agentConfigRow = await queryOne(`SELECT config_json,current_version FROM agent_registry WHERE agent_key='queue-suggestions'`);
  const agentConfig = typeof agentConfigRow?.config_json === 'string'
    ? JSON.parse(agentConfigRow.config_json || '{}')
    : (agentConfigRow?.config_json || {});

  const { companyFirmMap, peopleByFirm } = await gatherInvestorDataForCompanies(companies);

  // Build structured context for Claude — it only needs to fill in the creative parts
  const companySections = companies.map(c => {
    const firms = companyFirmMap[c.id] || [];
    const peopleLines = firms.flatMap(firm => {
      const people = peopleByFirm[firm] || [];
      return people.slice(0, 2).map(p => `  • ${p.name} | ${p.role} | ${firm} [Tier ${p.tier}]`);
    }).join('\n') || '  (no people found — Claude may suggest based on firm names)';

    return `ID:${c.id} | ${c.name} | ${c.sector} | ${c.stage || 'unknown'}
  ${c.description || ''}
  Investor firms: ${firms.join(', ') || 'unknown'}
  Accessible people found:\n${peopleLines}`;
  }).join('\n\n');

  const contactsLine = contacts.map(c => `${c.name} (${c.firm})`).join(', ') || 'none yet';

  const adaptiveBlock = agentConfig.taste_profile
    ? `\nADAPTIVE SEARCH & RANKING PROFILE (approved agent version ${agentConfigRow.current_version}):\n${agentConfig.taste_profile}\nUse this to prioritize timing, contact paths, and angles, but never invent missing company facts.\n`
    : '';

  const prompt = `You are a VC networking strategist. For each company below, generate an outreach card as JSON.

Use ONLY the people listed under "Accessible people found". Do not invent names. If a firm shows no people, leave that slot null.
${adaptiveBlock}

My contacts (warm intro potential): ${contactsLine}

For each company produce:
- timing: 1 sentence on why this is a good moment to reach out
- warm: the single best warm intro path via one of my contacts — reason specifically why they'd know this investor. If no credible link exists, set to null.
- cold: top 2 accessible people (lowest tier number = highest priority) with a distinct 1-sentence outreach angle each

Return ONLY a valid JSON array, no other text:
[
  {
    "company_id": <number>,
    "timing": "...",
    "warm": { "name": "...", "firm": "...", "role": "...", "tier": <number>, "via": "...", "angle": "..." } | null,
    "cold": [
      { "name": "...", "firm": "...", "role": "...", "tier": <number>, "angle": "..." }
    ]
  }
]

COMPANIES:
${companySections}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const raw = msg.content[0].text.trim();
    const jsonStr = raw.match(/\[[\s\S]*\]/)?.[0] || '[]';
    const cards = JSON.parse(jsonStr);

    // Hydrate with full company data
    const companyMap = {};
    companies.forEach(c => { companyMap[c.id] = c; });

    return cards.map(card => {
      const c = companyMap[card.company_id] || {};
      return {
        company_id: card.company_id,
        company_name: c.name || '',
        sector: c.sector || '',
        stage: c.stage || '',
        description: c.description || '',
        website: c.website || '',
        location: c.location || '',
        founded_year: c.founded_year || '',
        last_funding: c.last_funding || '',
        funding_amount: c.funding_amount || '',
        investor_firms: c.investor_firms || '',
        notes: c.notes || '',
        score: c.score || null,
        status: c.status || 'new',
        timing: card.timing || '',
        warm: card.warm || null,
        cold: card.cold || [],
      };
    });
  } catch (_) {
    return [];
  }
}

// ─── OUTREACH DRAFT ────────────────────────────────────────────────────────
// Reads the saved profile (resume data + distilled taste profile) from the DB
// and maps it to the shape runOutreachDraft uses. Returns null if no real profile yet.
async function loadUserProfile() {
  try {
    const { queryOne } = require('./db');
    const p = await queryOne('SELECT * FROM user_profile ORDER BY id LIMIT 1');
    if (!p) return null;
    const parse = v => { if (!v) return []; if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch (_) { return []; } };
    const exps = parse(p.experiences);
    const edu = parse(p.education);
    const hasContent = (p.full_name || '').trim() || p.elevator_pitch || exps.length || p.skills || p.taste_profile;
    if (!hasContent) return null;
    const name = (p.full_name || '').trim();
    const firstName = name.split(/\s+/)[0] || name;
    const recentExp = exps[0];
    return {
      name: firstName || 'I',
      fullName: name,
      background: recentExp ? `${recentExp.title || 'professional'}${recentExp.company ? ' at ' + recentExp.company : ''}` : '',
      targetRoles: p.target_roles || '',
      pitch: p.elevator_pitch || '',
      skills: p.skills || '',
      experienceSummary: exps.slice(0, 3).map(e => `${e.title || ''}${e.company ? ' @ ' + e.company : ''}`).filter(s => s.trim()).join('; '),
      educationSummary: edu.slice(0, 2).map(e => `${e.degree || ''}${e.field ? ' in ' + e.field : ''}${e.school ? ', ' + e.school : ''}`).filter(s => s.replace(/[,]/g, '').trim()).join('; '),
      preferredTone: p.preferred_tone || '',
      emailSignature: p.email_signature || name || firstName,
      taste: p.taste_profile || '',
      linkedinUrl: p.linkedin_url || '',
      portfolioUrl: p.portfolio_url || '',
    };
  } catch (_) { return null; }
}

// Rerank a bounded, already-eligible company shortlist using the user's distilled taste.
// The scheduler's deterministic ordering remains the fallback if Claude is unavailable.
async function rankCompaniesByTaste(companies, limit = 2) {
  if (!Array.isArray(companies) || !companies.length) return [];

  const profile = await loadUserProfile();
  if (!profile || !profile.taste || !process.env.ANTHROPIC_API_KEY) {
    return companies.slice(0, limit);
  }

  const candidates = companies.map((c, index) => ({
    baseline_rank: index + 1,
    company_id: c.id,
    name: c.name,
    sector: c.sector || '',
    stage: c.stage || '',
    description: c.description || '',
    location: c.location || '',
    notes: c.notes || '',
    pipeline_score: c.score ?? null,
  }));

  const prompt = `You are ranking an already-eligible shortlist of startup networking leads.

Score companies higher when their documented sector, stage, mission, operating style, or other concrete attributes align with the user's distilled preferences. Use ONLY the supplied company data. Do not infer missing facts. Missing information should lower confidence, not become a negative signal. Treat the existing baseline rank as a tie-breaker so recency and pipeline score still matter.

USER TASTE PROFILE:
${profile.taste}

Return ONLY a valid JSON array containing every company exactly once, ordered best match first:
[
  { "company_id": <number>, "taste_score": <integer 0-100>, "reason": "<one short evidence-based sentence>" }
]

CANDIDATES:
${JSON.stringify(candidates, null, 2)}`;

  try {
    const client = getClient();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = msg.content[0].text.trim();
    const jsonStr = raw.match(/\[[\s\S]*\]/)?.[0] || '[]';
    const rankings = JSON.parse(jsonStr);
    const byId = new Map(companies.map(c => [String(c.id), c]));
    const seen = new Set();
    const ordered = [];

    for (const ranking of rankings) {
      const id = String(ranking.company_id);
      if (!byId.has(id) || seen.has(id)) continue;
      seen.add(id);
      ordered.push(byId.get(id));
    }
    for (const company of companies) {
      const id = String(company.id);
      if (!seen.has(id)) ordered.push(company);
    }

    return ordered.slice(0, limit);
  } catch (error) {
    console.warn('[DailyRanking] Taste reranking failed; using baseline order:', error.message);
    return companies.slice(0, limit);
  }
}

// userProfile: pass an explicit profile object, or null to load the saved profile from the DB
// (falling back to sensible defaults if no profile has been set up yet).
async function runOutreachDraft(company, investor, userProfile = null) {
  const client = getClient();
  const EXA_KEY = process.env.EXA_API_KEY;

  const profile = userProfile || (await loadUserProfile()) || {
    name: 'Luke',
    fullName: 'Luke Struthers',
    background: 'venture researcher',
    targetRoles: 'operations, business development, research, or strategy',
    pitch: 'analytically sharp and well-networked, with experience mapping startup ecosystems and sourcing deals',
    skills: '',
    experienceSummary: '',
    educationSummary: '',
    preferredTone: '',
    emailSignature: 'Luke Struthers',
    taste: '',
  };

  // Search for recent public activity from this investor
  let recentActivity = '';
  if (EXA_KEY) {
    try {
      const data = await trackedExaSearch({
        query: `"${investor.name}" "${investor.firm}" investment portfolio recent`,
        num_results: 3,
        text: { maxCharacters: 500 },
      });
      recentActivity = (data.results || []).slice(0, 3).map(r => `- ${r.title}: ${r.text || ''}`).join('\n');
    } catch (_) {}
  }

  const aboutLines = [
    profile.pitch && `- Pitch: ${profile.pitch}`,
    profile.background && `- Currently: ${profile.background}`,
    profile.experienceSummary && `- Experience: ${profile.experienceSummary}`,
    profile.educationSummary && `- Education: ${profile.educationSummary}`,
    profile.skills && `- Skills: ${profile.skills}`,
    profile.targetRoles && `- Targeting: ${profile.targetRoles}`,
  ].filter(Boolean).join('\n');

  const voiceBlock = profile.taste
    ? `VOICE & PREFERENCES — learned from ${profile.name}'s own "this or that" choices. Follow this closely; it defines the tone and the kind of ask ${profile.name} is comfortable making:\n${profile.taste}\n`
    : (profile.preferredTone ? `Preferred tone: ${profile.preferredTone}\n` : '');

  const prompt = `You are writing a cold outreach message on behalf of ${profile.name}${profile.fullName && profile.fullName !== profile.name ? ` (${profile.fullName})` : ''}.

ABOUT ${(profile.name || '').toUpperCase()}:
${aboutLines || '- An ambitious early-career professional breaking into the startup ecosystem.'}

${voiceBlock}
Write ONE ready-to-send message (150 words MAX). It must:
1. Open with a specific, genuine hook — reference their firm's investment in ${company.name} or a recent move from the activity below
2. Establish who ${profile.name} is in 1 sentence, grounded ONLY in the real background above (never invent credentials)
3. Make an ask that matches ${profile.name}'s comfort level and voice described above — don't push a harder ask than their preferences suggest
4. Sound human, not corporate. No "I hope this message finds you well."
5. Close with: ${profile.emailSignature}

Target: ${investor.name} | ${investor.firm} | ${investor.role || 'Investor'}
Company context: ${company.name} — ${company.sector} startup — "${company.description || 'no description'}"

${recentActivity ? `Recent activity found:\n${recentActivity}` : '(no recent activity found — write based on firm/company context)'}

Output ONLY the message text, nothing else.`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 350,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text.trim();
}

// ─── AUTONOMOUS DRAFT GENERATION ───────────────────────────────────────────
// Called nightly by the scheduler. Picks targets from runQueueSuggestions,
// finds emails, writes personalized drafts, saves to drafts table.
async function runAutonomousDraftGeneration(companies, userProfile = null) {
  const crypto = require('crypto');
  const { execute, queryOne, today } = require('./db');
  const EXA_KEY = process.env.EXA_API_KEY;
  const savedDrafts = [];

  // Get structured investor targets for each company (runs Exa firm search internally)
  const cards = await runQueueSuggestions(companies);

  for (const card of cards) {
    const company = companies.find(c => c.id === card.company_id);
    if (!company) continue;

    // Best target: warm path first, then first cold contact
    const target = card.warm || (card.cold && card.cold[0]);
    if (!target || !target.name) continue;

    // Skip if a pending draft for this investor + company already exists today
    const existing = await queryOne(
      `SELECT id FROM drafts
       WHERE company_id = $1 AND LOWER(investor_name) = LOWER($2)
         AND status = 'pending' AND created_at >= $3`,
      [card.company_id, target.name, today() + ' 00:00:00']
    );
    if (existing) {
      console.log(`[AutoDraft] Skipping ${target.name} — draft already pending`);
      continue;
    }

    // Find email via Exa
    let email = null;
    if (EXA_KEY) {
      try {
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const skipList = ['noreply', 'no-reply', 'support', 'info@', 'hello@', 'contact@', 'privacy@', 'press@', 'jobs@'];
        const searchQueries = [
          `"${target.name}" "${target.firm}" email contact`,
          `"${target.name}" site:linkedin.com email`,
        ];
        emailSearch: for (const q of searchQueries) {
          const data = await trackedExaSearch({ query: q, num_results: 5, text: { maxCharacters: 500 } });
          for (const result of (data.results || [])) {
            const blob = `${result.text || ''} ${result.url}`;
            const emails = blob.match(emailRegex) || [];
            const found = emails.find(e => !skipList.some(s => e.toLowerCase().includes(s)));
            if (found) { email = found; break emailSearch; }
          }
        }
      } catch (_) {}
    }

    // Generate personalized draft
    let body = '';
    try {
      body = await runOutreachDraft(company, target, userProfile);
    } catch (err) {
      console.error(`[AutoDraft] Draft failed for ${target.name}: ${err.message}`);
      continue;
    }

    const token = crypto.randomBytes(32).toString('hex');
    await execute(
      `INSERT INTO drafts (company_id, investor_name, investor_email, subject, body, approve_token)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [company.id, target.name, email || null,
       `Introduction — ${company.name} / ${target.firm}`, body, token]
    );

    savedDrafts.push({ company: company.name, investor: target.name, hasEmail: !!email });
    console.log(`[AutoDraft] ${target.name} @ ${target.firm} — email: ${email || 'not found'}`);
  }

  return savedDrafts;
}

// ─── INVESTOR DOSSIER ──────────────────────────────────────────────────────
async function runInvestorDossier(name, firm) {
  const client = getClient();
  const EXA_KEY = process.env.EXA_API_KEY;

  let searchText = '';
  if (EXA_KEY) {
    try {
      const query = `"${name}" "${firm}" venture capital investments portfolio`;
      const data = await trackedExaSearch({ query, num_results: 5, text: { maxCharacters: 600 } });
      searchText = (data.results || [])
        .map(r => `[${r.title}](${r.url})\n${r.text || ''}`)
        .join('\n---\n');
    } catch (_) {}
  }

  const prompt = `You are a VC researcher preparing a pre-outreach dossier. Be specific and factual — only include things you can confirm from the search results. Don't pad with generic statements.

Format EXACTLY as:

DOSSIER: ${name} · ${firm}

Background
[2 sentences: their role, how long at the firm, background before VC if visible]

Recent Deals
[3 bullet points of specific companies they've backed — with sector/stage if known. If unsure, note it.]

What They Care About
[2-3 themes from their investments or public statements — be specific, not generic]

Conversation Hooks
→ [Hook 1 — reference a specific portfolio company or investment thesis]
→ [Hook 2 — a topic or trend they've publicly discussed]
→ [Hook 3 — a genuine question about their thesis or a sector view]

Best Approach
[1 sentence: LinkedIn DM / email / warm intro — and any nuance about their responsiveness]

---
SEARCH RESULTS:
${searchText || '(no results — use knowledge of this person and firm)'}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text.trim();
}

async function runWeeklyRecap(pipelineStats) {
  const client = getClient();
  const { total, byStatus, recentActions, topCompanies } = pipelineStats;

  const statusLines = Object.entries(byStatus)
    .map(([s, n]) => `  ${s}: ${n}`).join('\n');
  const actionLines = (recentActions || []).slice(0, 5)
    .map(a => `  - ${a.suggested_action} (${a.company_name || 'unknown'})`).join('\n');
  const topLines = (topCompanies || []).slice(0, 5)
    .map(c => `  ${c.name} | ${c.sector} | ${c.status} | score: ${c.score || 'unscored'}`).join('\n');

  const prompt = `You are a sharp venture networking coach writing a Monday morning recap email for a venture researcher conducting a job search in AI, fitness/wearables, and clean tech.

Write a motivating, focused weekly recap. Tone: direct, smart, encouraging — like a good mentor. Not corporate fluff.

Structure EXACTLY as:

WEEKLY RECAP — Week of [current week]

**Pipeline Snapshot**
[2-3 sentence honest assessment of the pipeline state based on the stats]

**Top Priorities This Week**
[3 specific, actionable priorities based on the data]

**Companies to Watch**
[Brief call-out of 2-3 companies that deserve attention this week and why]

**Mindset for the Week**
[1 short paragraph — a reframe or insight to keep them sharp and motivated]

---
PIPELINE DATA:
Total companies tracked: ${total}
Status breakdown:
${statusLines || '  (no data)'}

Recent actions logged:
${actionLines || '  (none)'}

Top-scored companies:
${topLines || '  (none scored yet)'}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

// ─── EVENT DISCOVERY ───────────────────────────────────────────────────────

// Exa: search for Luma events featuring a specific investor or firm
async function searchLumaEventsForInvestor(investor) {
  const EXA_KEY = process.env.EXA_API_KEY;
  if (!EXA_KEY) return [];
  const name = investor.name || '';
  const firm = investor.firm || '';
  const queries = [
    `site:lu.ma "${name}" venture capital`,
    firm ? `site:lu.ma "${firm}" event San Francisco` : null,
  ].filter(Boolean);

  const allResults = [];
  for (const query of queries) {
    try {
      const data = await trackedExaSearch({ query, num_results: 4, text: { maxCharacters: 300 } });
      (data.results || []).forEach(r => {
        if (r.url && r.url.includes('lu.ma')) allResults.push(r);
      });
    } catch (_) {}
  }
  return allResults;
}

// Exa: search for general SF VC/startup events on Luma
async function searchSFVCEvents() {
  const EXA_KEY = process.env.EXA_API_KEY;
  if (!EXA_KEY) return [];
  const queries = [
    'site:lu.ma venture capital startup "San Francisco" 2025',
    'site:lu.ma AI "Bay Area" investor networking 2025',
    'site:lu.ma "San Francisco" VC founder meetup 2025',
  ];
  const results = [];
  await Promise.all(queries.map(async query => {
    try {
      const data = await trackedExaSearch({ query, num_results: 5, text: { maxCharacters: 300 } });
      (data.results || []).forEach(r => {
        if (r.url && r.url.includes('lu.ma')) results.push(r);
      });
    } catch (_) {}
  }));
  return results;
}

// Cross-reference Exa event results against tracked investors
// Returns array of { url, title, matchedInvestors }
function matchEventsToInvestors(exaResults, trackedInvestors) {
  const matched = [];
  const seen = new Set();

  for (const result of exaResults) {
    if (!result.url || seen.has(result.url)) continue;
    seen.add(result.url);

    const blob = `${result.title || ''} ${result.text || ''}`.toLowerCase();
    const matchedInvestors = trackedInvestors.filter(inv => {
      const name = (inv.name || '').toLowerCase();
      const firm = (inv.firm || '').toLowerCase();
      return (name.length > 2 && blob.includes(name)) ||
             (firm.length > 3 && blob.includes(firm));
    });

    matched.push({
      url: result.url,
      title: result.title || '',
      snippet: result.text || '',
      matchedInvestors,
    });
  }
  return matched;
}

// Full event discovery run: Exa only
async function runEventDiscovery(trackedInvestors) {
  const { queryOne, execute } = require('./db');

  // 1. Exa searches — investor-specific + general SF, run in parallel
  const [investorResults, sfResults] = await Promise.all([
    Promise.all(trackedInvestors.map(inv => searchLumaEventsForInvestor(inv)))
      .then(arrays => arrays.flat()),
    searchSFVCEvents(),
  ]);

  const allExa = [...investorResults, ...sfResults];
  const matched = matchEventsToInvestors(allExa, trackedInvestors);

  // 2. DB upsert — Exa title + snippet is enough
  const newEvents = [];

  for (const item of matched) {
    const matchIds = item.matchedInvestors.map(i => i.id).join(',');
    const matchNames = item.matchedInvestors.map(i => i.name || i.firm).join(', ');

    const existing = await queryOne('SELECT id FROM events WHERE event_url = $1', [item.url]);

    if (existing) {
      if (matchIds) {
        await execute(
          `UPDATE events SET matched_investor_ids = $1, matched_investor_names = $2
           WHERE event_url = $3 AND (matched_investor_ids IS NULL OR matched_investor_ids = '')`,
          [matchIds, matchNames, item.url]
        );
      }
      continue;
    }

    await execute(
      `INSERT INTO events
         (title, event_url, luma_event_id, event_date, end_date, location,
          description, host_name, matched_investor_ids, matched_investor_names, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (event_url) DO NOTHING`,
      [
        item.title, item.url, '', '', '', 'San Francisco, CA',
        item.snippet, '', matchIds, matchNames, 'exa',
      ]
    );
    newEvents.push({ title: item.title, event_url: item.url });
  }

  return newEvents;
}

function metered(agentKey, fn, optionsForArgs = () => ({})) {
  return async (...args) => {
    const options = optionsForArgs(...args);
    return executeAgent(agentKey, options, () => fn(...args));
  };
}

module.exports = {
  runBrief: metered('company-brief', runBrief, company => ({
    companyId: company?.id,
    input: { company },
    trigger: 'manual',
  })),
  runInvestorMap: metered('investor-map', runInvestorMap, company => ({
    companyId: company?.id,
    input: { company },
    trigger: 'manual',
  })),
  runExtractPortfolio: metered('portfolio-extraction', runExtractPortfolio, investor => ({
    input: { investor },
    trigger: 'manual',
  })),
  runDailyOutreachSuggestions: metered('queue-suggestions', runDailyOutreachSuggestions, companies => ({
    input: { companies },
    trigger: currentRun() ? 'agent-triggered' : 'scheduled',
  })),
  runWeeklyRecap: metered('weekly-recap', runWeeklyRecap, pipelineStats => ({
    input: { pipelineStats },
    trigger: 'scheduled',
  })),
  runQueueSuggestions: metered('queue-suggestions', runQueueSuggestions, companies => ({
    input: { companies },
    trigger: currentRun() ? 'agent-triggered' : 'manual',
  })),
  runOutreachDraft: metered('outreach-draft', runOutreachDraft, company => ({
    companyId: company?.id,
    input: { company },
    trigger: currentRun() ? 'agent-triggered' : 'manual',
  })),
  runAutonomousDraftGeneration: metered('autonomous-drafts', runAutonomousDraftGeneration, companies => ({
    input: { companies },
    trigger: 'scheduled',
  })),
  runInvestorDossier: metered('investor-dossier', runInvestorDossier, (name, firm) => ({
    input: { name, firm },
    trigger: 'manual',
  })),
  runEventDiscovery: metered('event-discovery', runEventDiscovery, trackedInvestors => ({
    input: { trackedInvestors },
    trigger: 'manual',
  })),
  runFirmDiscovery: metered('firm-discovery', runFirmDiscovery, (firmName, pipelineCompanies) => ({
    input: { firmName, pipelineCompanies },
    trigger: 'manual',
  })),
  rankCompaniesByTaste: metered('daily-candidate-ranking', rankCompaniesByTaste, companies => ({
    input: { companies },
    trigger: 'scheduled',
  })),
  searchFirmForPeople,
  extractAccessiblePeopleFromFirms,
  loadUserProfile,
};
