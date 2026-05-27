const express = require('express');
const router = express.Router();
const { query, execute } = require('../db');
const { runEventDiscovery } = require('../agents');

// GET /api/events — list upcoming events, sorted by date
router.get('/', async (req, res) => {
  const events = await query(`
    SELECT * FROM events
    WHERE dismissed = 0
    ORDER BY
      CASE WHEN event_date = '' OR event_date IS NULL THEN 1 ELSE 0 END,
      event_date ASC,
      created_at DESC
  `);
  res.json(events);
});

// POST /api/events/scan — Exa discovery for flagged investors
router.post('/scan', async (req, res) => {
  const trackedInvestors = await query(
    'SELECT * FROM investors WHERE track_events = 1 ORDER BY name'
  );

  if (!trackedInvestors.length) {
    return res.json({ found: 0, message: 'No investors flagged. Click 📍 Track Events on investors in the Investors tab first.' });
  }

  try {
    const newEvents = await runEventDiscovery(trackedInvestors);
    res.json({ found: newEvents.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/events/:id — update dismissed / registered / notes
router.patch('/:id', async (req, res) => {
  const allowed = ['dismissed', 'registered', 'notes'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const vals = [...fields.map(f => req.body[f]), req.params.id];
  await execute(`UPDATE events SET ${sets} WHERE id = $${fields.length + 1}`, vals);
  res.json({ ok: true });
});

// DELETE /api/events/:id
router.delete('/:id', async (req, res) => {
  await execute('DELETE FROM events WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
