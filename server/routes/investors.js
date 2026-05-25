const express = require('express');
const router = express.Router();
const db = require('../db');
const { runExtractPortfolio } = require('../agents');

router.get('/', (req, res) => {
  res.json(db.prepare(
    'SELECT * FROM investors ORDER BY last_touched DESC NULLS LAST, created_at DESC'
  ).all());
});

router.post('/', (req, res) => {
  const { name, firm, role, stage_focus, sector_focus, how_i_know_them, relationship_status, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const run = db.prepare(`
    INSERT INTO investors (name, firm, role, stage_focus, sector_focus, how_i_know_them, relationship_status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, firm||'', role||'', stage_focus||'', sector_focus||'', how_i_know_them||'', relationship_status||'cold', notes||'');
  res.json({ id: run.lastInsertRowid });
});

router.patch('/:id', (req, res) => {
  const allowed = ['name','firm','role','stage_focus','sector_focus','portfolio_companies',
                   'how_i_know_them','relationship_status','last_touched','notes'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE investors SET ${sets} WHERE id = @id`).run({ ...req.body, id: req.params.id });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM investors WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Research portfolio via Exa + Claude extraction
router.post('/:id/research', async (req, res) => {
  const investor = db.prepare('SELECT * FROM investors WHERE id = ?').get(req.params.id);
  if (!investor) return res.status(404).json({ error: 'Investor not found' });

  const EXA_KEY = process.env.EXA_API_KEY;
  if (!EXA_KEY) return res.status(400).json({ error: 'EXA_API_KEY not set in .env — add it and restart' });

  // 1. Search Exa for portfolio info
  const query = `${investor.name} ${investor.firm || ''} portfolio companies investments`.trim();
  let exaData;
  try {
    const resp = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': EXA_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, num_results: 5, text: { maxCharacters: 1500 } }),
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
  db.prepare("UPDATE investors SET portfolio_companies = ?, last_touched = datetime('now') WHERE id = ?")
    .run(extracted, investor.id);

  // 4. Cross-reference with companies table (case-insensitive partial match)
  const allCompanies = db.prepare('SELECT id, name, sector, status FROM companies').all();
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
