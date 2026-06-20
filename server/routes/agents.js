const express = require('express');
const router = express.Router();
const { queryOne, execute, nowText } = require('../db');
const { runBrief, runInvestorMap } = require('../agents');

async function runAgent(req, res, agentType, agentFn) {
  const { company_id, network_context } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id required' });

  const company = await queryOne('SELECT * FROM companies WHERE id = $1', [company_id]);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  let output;
  try {
    output = await agentFn(company, network_context || '');
  } catch (err) {
    return res.status(502).json({ error: 'Agent error: ' + err.message });
  }

  // Update last_touched
  await execute(
    'UPDATE companies SET last_touched = $1 WHERE id = $2',
    [nowText(), company_id]
  );

  res.json({ output });
}

router.post('/brief', (req, res) => runAgent(req, res, 'brief', runBrief));
router.post('/investor-map', (req, res) => runAgent(req, res, 'investor-map', runInvestorMap));

module.exports = router;
