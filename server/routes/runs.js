const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db');

router.get('/', async (req, res) => {
  const runs = await query(`
    SELECT r.id, r.company_id, r.agent_type, r.created_at, c.name as company_name
    FROM agent_runs r
    LEFT JOIN companies c ON c.id = r.company_id
    ORDER BY r.created_at DESC
  `);
  res.json(runs);
});

router.get('/:id', async (req, res) => {
  const run = await queryOne('SELECT * FROM agent_runs WHERE id = $1', [req.params.id]);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json(run);
});

module.exports = router;
