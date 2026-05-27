const express = require('express');
const router = express.Router();
const { query, queryOne, execute, nowText } = require('../db');
const { runExtractPortfolio } = require('../agents');

router.get('/', async (req, res) => {
  res.json(await query(
    'SELECT * FROM investors ORDER BY last_touched DESC NULLS LAST, created_at DESC'
  ));
});

router.post('/', async (req, res) => {
  const { name, firm, role, stage_focus, sector_focus, how_i_know_them, relationship_status, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const result = await execute(
    `INSERT INTO investors (name, firm, role, stage_focus, sector_focus, how_i_know_them, relationship_status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [name, firm||'', role||'', stage_focus||'', sector_focus||'', how_i_know_them||'', relationship_status||'cold', notes||'']
  );
  res.json({ id: result.lastInsertRowid });
});

router.patch('/:id', async (req, res) => {
  const allowed = ['name','firm','role','stage_focus','sector_focus','portfolio_companies',
                   'how_i_know_them','relationship_status','last_touched','notes','track_events'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const vals = [...fields.map(f => req.body[f]), req.params.id];
  await execute(`UPDATE investors SET ${sets} WHERE id = $${fields.length + 1}`, vals);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await execute('DELETE FROM investors WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Research portfolio via Exa + Claude extraction
router.post('/:id/research', async (req, res) => {
  const investor = await queryOne('SELECT * FROM investors WHERE id = $1', [req.params.id]);
  if (!investor) return res.status(404).json({ error: 'Investor not found' });

  const EXA_KEY = process.env.EXA_API_KEY;
  if (!EXA_KEY) return res.status(400).json({ error: 'EXA_API_KEY not set in .env — add it and restart' });

  // 1. Search Exa for portfolio info
  const q = `${investor.name} ${investor.firm || ''} portfolio companies investments`.trim();
  let exaData;
  try {
    const resp = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': EXA_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, num_results: 5, text: { maxCharacters: 1500 } }),
    });
    exaData = await resp.json();
    if (!resp.ok) throw new Error(exaData.message || resp.statusText);
  } catch (err) {
    return res.status(502).json({ error: 'Exa search failed: ' + err.message });
  }

  // 2. Combine search text and pass to Claude for extraction
  const searchText = (exaData.results || [])
    .map(r => `[${r.title}]\n${r.url}\n${r.text || ''}`)
    .join('\n\n---\n\n')
    .slice(0, 5000);

  if (!searchText.trim()) return res.status(502).json({ error: 'Exa returned no results for this investor' });

  let extracted;
  try {
    extracted = await runExtractPortfolio(investor, searchText);
  } catch (err) {
    return res.status(502).json({ error: 'Extraction failed: ' + err.message });
  }

  if (extracted === 'NONE' || !extracted) {
    return res.json({ portfolio_companies: '', matches: [], message: 'No portfolio companies found in search results' });
  }

  // 3. Store portfolio_companies and update last_touched
  await execute(
    'UPDATE investors SET portfolio_companies = $1, last_touched = $2 WHERE id = $3',
    [extracted, nowText(), investor.id]
  );

  // 4. Cross-reference with companies table
  const allCompanies = await query('SELECT id, name, sector, status FROM companies');
  const portfolioLines = extracted.split('\n').map(s => s.trim()).filter(Boolean);
  const matches = [];
  for (const line of portfolioLines) {
    const lower = line.toLowerCase();
    for (const c of allCompanies) {
      const cLower = c.name.toLowerCase();
      if (lower.includes(cLower) || cLower.includes(lower)) {
        if (!matches.find(m => m.id === c.id)) matches.push(c);
      }
    }
  }

  res.json({ portfolio_companies: extracted, matches });
});

module.exports = router;
