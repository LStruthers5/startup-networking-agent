const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');

router.get('/', async (req, res) => {
  const runs = await query(`
    SELECT r.id, r.company_id, r.agent_type, r.agent_key, r.trigger_type, r.status,
      r.duration_ms, r.provider, r.model, r.input_tokens, r.output_tokens, r.provider_calls,
      r.exact_cost_usd, r.estimated_cost_usd, r.cost_basis, r.output_count,
      r.duplicate_count, r.actionable_count, r.accepted_count, r.error_text,
      r.created_at, c.name as company_name, reg.name as agent_name
    FROM agent_runs r
    LEFT JOIN companies c ON c.id = r.company_id
    LEFT JOIN agent_registry reg ON reg.agent_key = r.agent_key
    ORDER BY r.created_at DESC
    LIMIT 300
  `);
  res.json(runs);
});

router.get('/:id', async (req, res) => {
  const run = await queryOne('SELECT * FROM agent_runs WHERE id = $1', [req.params.id]);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json(run);
});

module.exports = router;
