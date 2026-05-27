const express = require('express');
const router = express.Router();
const db = require('../db');

// Follow-up schedule: days to add after completing each step
const FOLLOW_UP_DAYS = { 1: 7, 2: 10 }; // step 1 done → follow-up in 7d; step 2 done → 10d; step 3 is final

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function followUpText(step) {
  if (step === 2) return 'Follow up — no response yet. Brief nudge or new angle.';
  if (step === 3) return 'Final check-in. If no response after this, mark as archived.';
  return 'Follow up';
}

// List: companies with their open actions, sorted by urgency (overdue first, then by last_touched)
router.get('/', (req, res) => {
  const companies = db.prepare(`
    SELECT c.id, c.name, c.status, c.sector, c.last_touched,
           a.id as action_id, a.suggested_action, a.due_date, a.completed,
           a.notes as action_notes, a.sequence_step, a.contact_context, a.outreach_type
    FROM companies c
    LEFT JOIN actions a ON a.company_id = c.id AND a.completed = 0
    ORDER BY
      CASE WHEN a.due_date IS NOT NULL AND a.due_date <= date('now') THEN 0 ELSE 1 END ASC,
      a.due_date ASC NULLS LAST,
      c.last_touched DESC NULLS LAST,
      c.date_added DESC
  `).all();
  res.json(companies);
});

router.post('/', (req, res) => {
  const { company_id, suggested_action, due_date, sequence_step, contact_context, outreach_type } = req.body;
  if (!company_id || !suggested_action) return res.status(400).json({ error: 'company_id and suggested_action required' });

  const run = db.prepare(`
    INSERT INTO actions (company_id, suggested_action, due_date, sequence_step, contact_context, outreach_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    company_id,
    suggested_action,
    due_date || null,
    sequence_step || 1,
    contact_context || '',
    outreach_type || 'investor'
  );

  res.json({ id: run.lastInsertRowid });
});

router.patch('/:id', (req, res) => {
  const allowed = ['completed', 'notes', 'due_date', 'contact_context'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });

  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE actions SET ${sets} WHERE id = @id`).run({ ...req.body, id: req.params.id });

  // Auto-schedule follow-up when an action is marked complete
  let followUp = null;
  if (req.body.completed === 1 || req.body.completed === true) {
    const action = db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
    if (action && action.sequence_step < 3) {
      const nextStep = action.sequence_step + 1;
      const daysOut = FOLLOW_UP_DAYS[action.sequence_step] || 7;
      const dueDate = addDays(daysOut);
      const run = db.prepare(`
        INSERT INTO actions (company_id, suggested_action, due_date, sequence_step, contact_context, outreach_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        action.company_id,
        followUpText(nextStep),
        dueDate,
        nextStep,
        action.contact_context || '',
        action.outreach_type || 'investor'
      );
      followUp = { id: run.lastInsertRowid, step: nextStep, due_date: dueDate };
    }
  }

  res.json({ ok: true, followUp });
});

module.exports = router;
