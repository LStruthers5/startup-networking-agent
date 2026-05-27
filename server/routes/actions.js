const express = require('express');
const router = express.Router();
const { query, queryOne, execute, today, daysFromNow } = require('../db');

// Follow-up schedule: days to add after completing each step
const FOLLOW_UP_DAYS = { 1: 7, 2: 10 };

function followUpText(step) {
  if (step === 2) return 'Follow up — no response yet. Brief nudge or new angle.';
  if (step === 3) return 'Final check-in. If no response after this, mark as archived.';
  return 'Follow up';
}

// List: companies with their open actions, sorted by urgency (overdue first)
router.get('/', async (req, res) => {
  const companies = await query(`
    SELECT c.id, c.name, c.status, c.sector, c.last_touched,
           a.id as action_id, a.suggested_action, a.due_date, a.completed,
           a.notes as action_notes, a.sequence_step, a.contact_context, a.outreach_type
    FROM companies c
    LEFT JOIN actions a ON a.company_id = c.id AND a.completed = 0
    ORDER BY
      CASE WHEN a.due_date IS NOT NULL AND a.due_date <= $1 THEN 0 ELSE 1 END ASC,
      a.due_date ASC NULLS LAST,
      c.last_touched DESC NULLS LAST,
      c.date_added DESC
  `, [today()]);
  res.json(companies);
});

router.post('/', async (req, res) => {
  const { company_id, suggested_action, due_date, sequence_step, contact_context, outreach_type } = req.body;
  if (!company_id || !suggested_action) return res.status(400).json({ error: 'company_id and suggested_action required' });

  const result = await execute(
    `INSERT INTO actions (company_id, suggested_action, due_date, sequence_step, contact_context, outreach_type)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [company_id, suggested_action, due_date || null, sequence_step || 1, contact_context || '', outreach_type || 'investor']
  );
  res.json({ id: result.lastInsertRowid });
});

router.patch('/:id', async (req, res) => {
  const allowed = ['completed', 'notes', 'due_date', 'contact_context'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });

  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const vals = [...fields.map(f => req.body[f]), req.params.id];
  await execute(`UPDATE actions SET ${sets} WHERE id = $${fields.length + 1}`, vals);

  // Auto-schedule follow-up when an action is marked complete
  let followUp = null;
  if (req.body.completed === 1 || req.body.completed === true) {
    const action = await queryOne('SELECT * FROM actions WHERE id = $1', [req.params.id]);
    if (action && action.sequence_step < 3) {
      const nextStep = action.sequence_step + 1;
      const daysOut = FOLLOW_UP_DAYS[action.sequence_step] || 7;
      const dueDate = daysFromNow(daysOut);
      const result = await execute(
        `INSERT INTO actions (company_id, suggested_action, due_date, sequence_step, contact_context, outreach_type)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [action.company_id, followUpText(nextStep), dueDate, nextStep, action.contact_context || '', action.outreach_type || 'investor']
      );
      followUp = { id: result.lastInsertRowid, step: nextStep, due_date: dueDate };
    }
  }

  res.json({ ok: true, followUp });
});

module.exports = router;
