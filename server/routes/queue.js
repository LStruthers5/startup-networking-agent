const express = require('express');
const router = express.Router();
const db = require('../db');
const { runQueueSuggestions, runOutreachDraft, runInvestorDossier } = require('../agents');

// Pick companies for the feed — avoid recently suggested, skip 'passed'
function pickFeedCandidates(n, skipIds = []) {
  const placeholders = skipIds.length ? skipIds.map(() => '?').join(',') : 'NULL';
  const sql = `
    SELECT * FROM companies
    WHERE status != 'passed'
    ${skipIds.length ? `AND id NOT IN (${placeholders})` : ''}
    ORDER BY
      last_suggested IS NULL DESC,
      last_suggested ASC,
      score DESC,
      last_touched ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(...skipIds, n);
}

// GET /api/queue/suggestions?skip=1,2,3&n=3
// Returns JSON cards for the UP NEXT feed
router.get('/suggestions', async (req, res) => {
  try {
    const skipIds = (req.query.skip || '').split(',').map(Number).filter(Boolean);
    const n = Math.min(parseInt(req.query.n || '3', 10), 6);
    const companies = pickFeedCandidates(n, skipIds);
    if (!companies.length) return res.json([]);
    const cards = await runQueueSuggestions(companies);
    res.json(cards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/draft
// Body: { company_id, investor_name, investor_firm, investor_role }
router.post('/draft', async (req, res) => {
  const { company_id, investor_name, investor_firm, investor_role } = req.body;
  if (!company_id || !investor_name) return res.status(400).json({ error: 'company_id and investor_name required' });

  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(company_id);
  if (!company) return res.status(404).json({ error: 'Company not found' });

  try {
    const draft = await runOutreachDraft(company, {
      name: investor_name,
      firm: investor_firm || '',
      role: investor_role || '',
    });
    res.json({ draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/dossier
// Body: { name, firm }
router.post('/dossier', async (req, res) => {
  const { name, firm } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const dossier = await runInvestorDossier(name, firm || '');
    res.json({ dossier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/queue/radar
// Overdue follow-ups with company context
router.get('/radar', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, c.name as company_name, c.sector, c.status as company_status
    FROM actions a
    JOIN companies c ON c.id = a.company_id
    WHERE a.completed = 0
      AND a.due_date IS NOT NULL
      AND a.due_date <= date('now', '+3 days')
    ORDER BY a.due_date ASC
    LIMIT 10
  `).all();
  res.json(rows);
});

// GET /api/queue/logged
// Recently completed outreaches with company context
router.get('/logged', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, c.name as company_name, c.sector
    FROM actions a
    JOIN companies c ON c.id = a.company_id
    WHERE a.completed = 1
    ORDER BY a.created_at DESC
    LIMIT 30
  `).all();
  res.json(rows);
});

// GET /api/queue/stats
// Summary numbers for the workbench header
router.get('/stats', (req, res) => {
  const sentThisWeek = db.prepare(`
    SELECT COUNT(*) as n FROM actions
    WHERE completed = 1 AND created_at >= date('now', '-7 days')
  `).get().n;

  const overdue = db.prepare(`
    SELECT COUNT(*) as n FROM actions
    WHERE completed = 0 AND due_date IS NOT NULL AND due_date < date('now')
  `).get().n;

  const openActions = db.prepare(`
    SELECT COUNT(*) as n FROM actions WHERE completed = 0
  `).get().n;

  res.json({ sentThisWeek, overdue, openActions });
});

module.exports = router;
