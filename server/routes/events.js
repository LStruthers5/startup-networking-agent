const express = require('express');
const router = express.Router();
const db = require('../db');
const { runEventDiscovery } = require('../agents');

// GET /api/events — list upcoming events, sorted by date
router.get('/', (req, res) => {
  const events = db.prepare(`
    SELECT * FROM events
    WHERE dismissed = 0
    ORDER BY
      CASE WHEN event_date = '' OR event_date IS NULL THEN 1 ELSE 0 END,
      event_date ASC,
      created_at DESC
  `).all();
  res.json(events);
});

// POST /api/events/scan — Exa discovery for flagged investors
router.post('/scan', async (req, res) => {
  const trackedInvestors = db.prepare(
    'SELECT * FROM investors WHERE track_events = 1 ORDER BY name'
  ).all();

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
router.patch('/:id', (req, res) => {
  const allowed = ['dismissed', 'registered', 'notes'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE events SET ${sets} WHERE id = @id`).run({ ...req.body, id: req.params.id });
  res.json({ ok: true });
});

// DELETE /api/events/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
