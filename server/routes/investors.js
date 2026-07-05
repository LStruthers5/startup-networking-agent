const express = require('express');
const router = express.Router();
const { query, queryOne, execute, nowText } = require('../db');
const { runExtractPortfolio, runFirmDiscovery } = require('../agents');
const { executeAgent, trackedExaSearch } = require('../agent-control');

// ─── GET all individual investors ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  res.json(await query(
    'SELECT * FROM investors ORDER BY relationship_status, last_touched DESC NULLS LAST, created_at DESC'
  ));
});

// ─── GET aggregated firm view ──────────────────────────────────────────────────
// Merges data from two sources:
//   1. companies.investor_firms (CSV field) → firm → pipeline company associations
//   2. investors.firm              → individual investors grouped by firm
router.get('/firms', async (req, res) => {
  try {
    const [companies, investors, patterns] = await Promise.all([
      query('SELECT id, name, sector, stage, status, investor_firms FROM companies WHERE investor_firms IS NOT NULL AND investor_firms != \'\''),
      query('SELECT * FROM investors ORDER BY firm, relationship_status, name'),
      query('SELECT firm, domain, pattern, example_email, confirmed_count FROM firm_email_patterns'),
    ]);
    const patternByFirm = {};
    for (const p of patterns) patternByFirm[p.firm.toLowerCase().trim()] = p;

    const firmMap = {}; // key: lowercase firm name

    // Source 1: extract firms from companies.investor_firms (CSV field)
    for (const c of companies) {
      const firmNames = (c.investor_firms || '').split(',').map(f => f.trim()).filter(Boolean);
      for (const fn of firmNames) {
        const key = fn.toLowerCase();
        if (!firmMap[key]) {
          firmMap[key] = { name: fn, pipeline_companies: [], individuals: [], source_tags: [] };
        }
        if (!firmMap[key].source_tags.includes('csv')) firmMap[key].source_tags.push('csv');
        // Avoid duplicate company entries
        if (!firmMap[key].pipeline_companies.find(x => x.id === c.id)) {
          firmMap[key].pipeline_companies.push({ id: c.id, name: c.name, sector: c.sector, stage: c.stage, status: c.status });
        }
      }
    }

    // Source 2: individual investors from investors table
    for (const inv of investors) {
      if (!inv.firm) continue;
      const key = inv.firm.toLowerCase().trim();
      if (!firmMap[key]) {
        firmMap[key] = { name: inv.firm, pipeline_companies: [], individuals: [], source_tags: [] };
      }
      const tag = inv.source || 'manual';
      if (!firmMap[key].source_tags.includes(tag)) firmMap[key].source_tags.push(tag);
      firmMap[key].individuals.push(inv);
    }

    // Compute derived fields and sort
    const REL_ORDER = { outreach_sent: 0, warm: 1, met: 2, cold: 3 };
    const firms = Object.values(firmMap).map(f => {
      // Best relationship status across all individuals at this firm
      const bestRel = f.individuals.reduce((best, inv) => {
        return (REL_ORDER[inv.relationship_status] ?? 99) < (REL_ORDER[best] ?? 99)
          ? inv.relationship_status
          : best;
      }, 'none');

      const emailPattern = patternByFirm[f.name.toLowerCase().trim()] || null;

      // Does user have a warm contact at this firm via the Contacts table? (resolved client-side)
      return {
        name: f.name,
        pipeline_companies: f.pipeline_companies,
        individuals: f.individuals,
        source_tags: f.source_tags,
        best_relationship: bestRel,
        pipeline_count: f.pipeline_companies.length,
        individual_count: f.individuals.length,
        email_pattern: emailPattern ? {
          pattern: emailPattern.pattern,
          domain: emailPattern.domain,
          example: emailPattern.example_email,
          confirmed_count: emailPattern.confirmed_count,
        } : null,
      };
    }).sort((a, b) =>
      // Sort: most pipeline companies first, then alphabetically
      b.pipeline_count - a.pipeline_count || a.name.localeCompare(b.name)
    );

    res.json(firms);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET coverage stats ────────────────────────────────────────────────────────
// Returns: total companies, how many have at least one investor contact (any relationship)
router.get('/coverage', async (req, res) => {
  try {
    const [totalRow, companies, investors] = await Promise.all([
      queryOne('SELECT COUNT(*) as n FROM companies WHERE status != \'passed\''),
      query('SELECT id, investor_firms FROM companies WHERE status != \'passed\''),
      query('SELECT firm, relationship_status FROM investors'),
    ]);

    const total = parseInt(totalRow?.n || 0);
    const warmFirms = new Set(
      investors.filter(i => ['warm','met','outreach_sent'].includes(i.relationship_status))
               .map(i => (i.firm || '').toLowerCase())
    );
    const anyFirms = new Set(investors.map(i => (i.firm || '').toLowerCase()));

    let warmCoverage = 0, anyCoverage = 0;
    for (const c of companies) {
      const firms = (c.investor_firms || '').split(',').map(f => f.trim().toLowerCase()).filter(Boolean);
      if (firms.some(f => warmFirms.has(f))) warmCoverage++;
      if (firms.some(f => anyFirms.has(f))) anyCoverage++;
    }

    const unconfirmedCount = await queryOne('SELECT COUNT(*) as n FROM investors WHERE confirmed = 0');

    res.json({
      total,
      warmCoverage,
      anyCoverage,
      unconfirmed: parseInt(unconfirmedCount?.n || 0),
      totalIndividuals: investors.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST create investor ──────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, firm, role, tier, stage_focus, sector_focus, how_i_know_them,
          relationship_status, notes, source, confirmed, source_company_id,
          investor_type, linkedin_url } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const result = await execute(
    `INSERT INTO investors
       (name, firm, role, tier, stage_focus, sector_focus, how_i_know_them,
        relationship_status, notes, source, confirmed, source_company_id,
        investor_type, linkedin_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      name, firm||'', role||'', tier||5,
      stage_focus||'', sector_focus||'', how_i_know_them||'',
      relationship_status||'cold', notes||'',
      source||'manual', confirmed===undefined ? 1 : confirmed,
      source_company_id||null,
      investor_type||'VC', linkedin_url||'',
    ]
  );
  res.json({ id: result.lastInsertRowid });
});

// ─── PATCH update investor ─────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const allowed = [
    'name','firm','role','tier','stage_focus','sector_focus','portfolio_companies',
    'how_i_know_them','relationship_status','last_touched','notes',
    'track_events','source','confirmed','source_company_id',
    'investor_type','linkedin_url',
  ];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const vals = [...fields.map(f => req.body[f]), req.params.id];
  await execute(`UPDATE investors SET ${sets} WHERE id = $${fields.length + 1}`, vals);
  res.json({ ok: true });
});

// ─── DELETE investor ───────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  await execute('DELETE FROM investors WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ─── POST discover individuals at a firm (agent) ───────────────────────────────
router.post('/firms/:firmName/discover', async (req, res) => {
  const firmName = decodeURIComponent(req.params.firmName);
  try {
    const companies = await query(
      'SELECT name, sector, stage FROM companies WHERE status != \'passed\' ORDER BY score DESC NULLS LAST LIMIT 10'
    );
    const discovered = await runFirmDiscovery(firmName, companies);

    const saved = [];
    const skipped = [];

    for (const inv of discovered) {
      if (!inv.name) continue;
      // Skip if this person already exists at this firm
      const existing = await queryOne(
        'SELECT id FROM investors WHERE LOWER(name) = LOWER($1) AND LOWER(COALESCE(firm,\'\')) = LOWER($2)',
        [inv.name, firmName]
      );
      if (existing) { skipped.push(inv.name); continue; }

      const result = await execute(
        `INSERT INTO investors (name, firm, role, tier, source, confirmed, relationship_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [inv.name, firmName, inv.role||'', inv.tier||5, 'agent', 0, 'cold']
      );
      saved.push({ ...inv, id: result.lastInsertRowid });
    }

    res.json({ saved, skipped, total_found: discovered.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST research portfolio (Exa + Claude) ────────────────────────────────────
router.post('/:id/research', async (req, res) => {
  const investor = await queryOne('SELECT * FROM investors WHERE id = $1', [req.params.id]);
  if (!investor) return res.status(404).json({ error: 'Investor not found' });

  const EXA_KEY = process.env.EXA_API_KEY;
  if (!EXA_KEY) return res.status(400).json({ error: 'EXA_API_KEY not set' });

  try {
    const extracted = await executeAgent('investor-portfolio-research', {
      trigger: 'manual',
      input: { investor },
    }, async () => {
      const q = `${investor.name} ${investor.firm || ''} portfolio companies investments`.trim();
      const exaData = await trackedExaSearch({ query: q, num_results: 5, text: { maxCharacters: 1500 } });
      const searchText = (exaData.results || [])
        .map(r => `[${r.title}]\n${r.url}\n${r.text || ''}`)
        .join('\n\n---\n\n')
        .slice(0, 5000);
      if (!searchText.trim()) throw new Error('Exa returned no results');
      return runExtractPortfolio(investor, searchText);
    });

    if (extracted === 'NONE' || !extracted) {
      return res.json({ portfolio_companies: '', matches: [], message: 'No portfolio companies found' });
    }

    await execute(
      'UPDATE investors SET portfolio_companies = $1, last_touched = $2 WHERE id = $3',
      [extracted, nowText(), investor.id]
    );

    const allCompanies = await query('SELECT id, name, sector, status FROM companies');
    const portfolioLines = extracted.split('\n').map(s => s.trim()).filter(Boolean);
    const matches = [];
    for (const line of portfolioLines) {
      const lower = line.toLowerCase();
      for (const c of allCompanies) {
        const cLower = c.name.toLowerCase();
        if ((lower.includes(cLower) || cLower.includes(lower)) && !matches.find(m => m.id === c.id)) {
          matches.push(c);
        }
      }
    }

    res.json({ portfolio_companies: extracted, matches });
  } catch (err) {
    res.status(502).json({ error: 'Portfolio research failed: ' + err.message });
  }
});

module.exports = router;
