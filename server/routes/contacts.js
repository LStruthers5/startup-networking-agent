const express = require('express');
const router = express.Router();
const { query, execute } = require('../db');

router.get('/', async (req, res) => {
  res.json(await query('SELECT * FROM contacts ORDER BY firm, name'));
});

router.post('/', async (req, res) => {
  const { name, firm, role, sector_focus, stage_focus, how_i_know_them, notes } = req.body;
  const result = await execute(
    `INSERT INTO contacts (name, firm, role, sector_focus, stage_focus, how_i_know_them, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [name||'', firm||'', role||'', sector_focus||'', stage_focus||'', how_i_know_them||'', notes||'']
  );
  res.json({ id: result.lastInsertRowid });
});

router.patch('/:id', async (req, res) => {
  const allowed = ['name', 'firm', 'role', 'sector_focus', 'stage_focus', 'how_i_know_them', 'notes'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const vals = [...fields.map(f => req.body[f]), req.params.id];
  await execute(`UPDATE contacts SET ${sets} WHERE id = $${fields.length + 1}`, vals);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await execute('DELETE FROM contacts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
