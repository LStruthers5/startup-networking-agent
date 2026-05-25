const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM contacts ORDER BY firm, name').all());
});

router.post('/', (req, res) => {
  const { name, firm, role, sector_focus, stage_focus, how_i_know_them, notes } = req.body;
  const run = db.prepare(`
    INSERT INTO contacts (name, firm, role, sector_focus, stage_focus, how_i_know_them, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name || '', firm || '', role || '', sector_focus || '', stage_focus || '', how_i_know_them || '', notes || '');
  res.json({ id: run.lastInsertRowid });
});

router.patch('/:id', (req, res) => {
  const allowed = ['name', 'firm', 'role', 'sector_focus', 'stage_focus', 'how_i_know_them', 'notes'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE contacts SET ${sets} WHERE id = @id`).run({ ...req.body, id: req.params.id });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
