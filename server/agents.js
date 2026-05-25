const MODEL = 'claude-sonnet-4-6';

function getClient() {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function buildContactsBlock() {
  const db = require('./db');
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY firm, name').all();
  if (!contacts.length) return '';
  const lines = contacts.map(c => {
    const label = c.name ? `${c.name} (${c.firm})` : c.firm;
    const rel = c.how_i_know_them || 'known contact';
    const extras = [c.role, c.sector_focus, c.stage_focus].filter(Boolean).join(', ');
    return `- ${label} — ${rel}${extras ? ` [${extras}]` : ''}`;
  }).join('\n');
  return `\nHere are people I have direct relationships with:\n${lines}\n\nWhere possible, prioritize these people or use them as explicit intro paths over generic network suggestions.`;
}

// Verify a single investor name+firm via Exa
async function verifyInvestorViaExa(name, firm) {
  const EXA_KEY = process.env.EXA_API_KEY;
  if (!EXA_KEY) return { confirmed: null, url: null }; // null = couldn't check

  try {
    const query = `"${name}" "${firm}" venture capital investor`;
    const resp = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': EXA_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, num_results: 3, text: { maxCharacters: 400 } }),
    });
    const data = await resp.json();
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
  const db = require('./db');

  // Pull user's saved investors — these are pre-verified, highest trust
  const savedInvestors = db.prepare('SELECT * FROM investors ORDER BY firm, name').all();
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
${buildContactsBlock()}`;

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

module.exports = { runBrief, runInvestorMap, runExtractPortfolio };
