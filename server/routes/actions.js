const express = require('express');
const router = express.Router();
const db = require('../db');

// Weekly queue: companies sorted by last_touched, with their open actions
router.get('/', (req, res) => {
  const companies = db.prepare(`
    SELECT c.id, c.name, c.status, c.sector, c.last_touched,
           a.id as action_id, a.suggested_action, a.due_date, a.completed, a.notes as action_notes
    FROM companies c
    LEFT JOIN actions a ON a.company_id = c.id AND a.completed = 0
    ORDER BY c.last_touched DESC NULLS LAST, c.date_added DESC
  `).all();
  res.json(companies);
});

router.post('/', (req, res) => {
  const { company_id, suggested_action, due_date } = req.body;
  if (!company_id || !suggested_action) return res.status(400).json({ error: 'company_id and suggested_action required' });

  const run = db.prepare(`
    INSERT INTO actions (company_id, suggested_action, due_date)
    VALUES (?, ?, ?)
  `).run(company_id, suggested_action, due_date || null);

  res.json({ id: run.lastInsertRowid });
});

router.patch('/:id', (req, res) => {
  const allowed = ['completed', 'notes', 'due_date'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });

  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE actions SET ${sets} WHERE id = @id`).run({ ...req.body, id: req.params.id });
  res.json({ ok: true });
});

module.exports = router;
