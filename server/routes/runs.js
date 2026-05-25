const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  const runs = db.prepare(`
    SELECT r.id, r.company_id, r.agent_type, r.created_at, c.name as company_name
    FROM agent_runs r
    LEFT JOIN companies c ON c.id = r.company_id
    ORDER BY r.created_at DESC
  `).all();
  res.json(runs);
});

router.get('/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json(run);
});

module.exports = router;
