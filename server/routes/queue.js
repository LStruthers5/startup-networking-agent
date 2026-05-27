const express = require('express');
const router = express.Router();
const { query, queryOne, execute, today, daysFromNow, daysAgo } = require('../db');
const { runQueueSuggestions, runOutreachDraft, runInvestorDossier } = require('../agents');

// Pick companies for the feed — avoid recently suggested, skip 'passed'
async function pickFeedCandidates(n, skipIds = []) {
  let sql = `
    SELECT * FROM companies
    WHERE status != 'passed'
  `;
  const params = [];
  if (skipIds.length) {
    sql += ` AND id NOT IN (${skipIds.map((_, i) => `$${i + 1}`).join(',')})`;
    params.push(...skipIds);
  }
  sql += `
    ORDER BY
      (last_suggested IS NULL) DESC,
      last_suggested ASC NULLS LAST,
      score DESC NULLS LAST,
      last_touched ASC NULLS LAST
    LIMIT $${params.length + 1}
  `;
  params.push(n);
  return query(sql, params);
}

// GET /api/queue/suggestions?skip=1,2,3&n=3
router.get('/suggestions', async (req, res) => {
  try {
    const skipIds = (req.query.skip || '').split(',').map(Number).filter(Boolean);
    const n = Math.min(parseInt(req.query.n || '3', 10), 6);
    const companies = await pickFeedCandidates(n, skipIds);
    if (!companies.length) return res.json([]);
    const cards = await runQueueSuggestions(companies);
    res.json(cards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/queue/draft
router.post('/draft', async (req, res) => {
  const { company_id, investor_name, investor_firm, investor_role } = req.body;
  if (!company_id || !investor_name) return res.status(400).json({ error: 'company_id and investor_name required' });

  const company = await queryOne('SELECT * FROM companies WHERE id = $1', [company_id]);
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

// GET /api/queue/radar — overdue follow-ups with company context
router.get('/radar', async (req, res) => {
  const rows = await query(`
    SELECT a.*, c.name as company_name, c.sector, c.status as company_status
    FROM actions a
    JOIN companies c ON c.id = a.company_id
    WHERE a.completed = 0
      AND a.due_date IS NOT NULL
      AND a.due_date <= $1
    ORDER BY a.due_date ASC
    LIMIT 10
  `, [daysFromNow(3)]);
  res.json(rows);
});

// GET /api/queue/logged — recently completed outreaches
router.get('/logged', async (req, res) => {
  const rows = await query(`
    SELECT a.*, c.name as company_name, c.sector
    FROM actions a
    JOIN companies c ON c.id = a.company_id
    WHERE a.completed = 1
    ORDER BY a.created_at DESC
    LIMIT 30
  `);
  res.json(rows);
});

// GET /api/queue/stats — summary numbers for the workbench header
router.get('/stats', async (req, res) => {
  const [sentRow, overdueRow, openRow] = await Promise.all([
    queryOne(`SELECT COUNT(*) as n FROM actions WHERE completed = 1 AND created_at >= $1`, [daysAgo(7)]),
    queryOne(`SELECT COUNT(*) as n FROM actions WHERE completed = 0 AND due_date IS NOT NULL AND due_date < $1`, [today()]),
    queryOne(`SELECT COUNT(*) as n FROM actions WHERE completed = 0`),
  ]);
  res.json({
    sentThisWeek: parseInt(sentRow?.n || 0),
    overdue: parseInt(overdueRow?.n || 0),
    openActions: parseInt(openRow?.n || 0),
  });
});

module.exports = router;
