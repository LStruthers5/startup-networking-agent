const express = require('express');
const router = express.Router();
const db = require('../db');
const { runBrief, runInvestorMap } = require('../agents');

async function runAgent(req, res, agentType, agentFn) {
  const { company_id, network_context } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id required' });

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(company_id);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  let output;
  try {
    output = await agentFn(company, network_context || '');
  } catch (err) {
    return res.status(502).json({ error: 'Agent error: ' + err.message });
  }

  const input_json = JSON.stringify({ company, network_context });
  const run = db.prepare(`
    INSERT INTO agent_runs (company_id, agent_type, input_json, output_text)
    VALUES (?, ?, ?, ?)
  `).run(company_id, agentType, input_json, output);

  // Update last_touched
  db.prepare("UPDATE companies SET last_touched = datetime('now') WHERE id = ?").run(company_id);

  res.json({ run_id: run.lastInsertRowid, output });
}

router.post('/brief', (req, res) => runAgent(req, res, 'brief', runBrief));
router.post('/investor-map', (req, res) => runAgent(req, res, 'investor-map', runInvestorMap));

module.exports = router;
