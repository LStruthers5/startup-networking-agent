const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db');

const APP_URL = () => process.env.APP_URL || 'http://localhost:3000';

function confirmPage(heading, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; background: #edf5f9; color: #0d1e30; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { background: #fff; border: 1px solid #bdd6e6; border-radius: 12px; padding: 40px; max-width: 480px; text-align: center; box-shadow: 0 4px 24px rgba(13,30,48,.08); }
  h1 { font-size: 22px; margin: 0 0 10px; color: #0d7ea5; }
  p { color: #5a7f9e; font-size: 15px; margin: 0 0 24px; line-height: 1.6; }
  a { display: inline-block; background: #0d1e30; color: #fff; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; }
</style></head><body>
<div class="box">
  <h1>${heading}</h1>
  <p>${message}</p>
  <a href="${APP_URL()}">Back to Tower</a>
</div></body></html>`;
}

// GET /api/drafts — list drafts by status
router.get('/', async (req, res) => {
  const status = req.query.status || 'pending';
  const rows = await query(
    `SELECT d.*, c.name as company_name
     FROM drafts d
     LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.status = $1
     ORDER BY d.created_at DESC`,
    [status]
  );
  res.json(rows);
});

// POST /api/drafts — save a draft from the UI
router.post('/', async (req, res) => {
  const { company_id, investor_name, investor_email, subject, body } = req.body;
  if (!body || !subject) return res.status(400).json({ error: 'subject and body required' });

  const token = crypto.randomBytes(32).toString('hex');
  const result = await execute(
    `INSERT INTO drafts (company_id, investor_name, investor_email, subject, body, approve_token)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [company_id || null, investor_name || '', investor_email || null, subject, body, token]
  );
  res.json({ id: result.lastInsertRowid, approve_token: token });
});

// GET /api/drafts/approve/:token — one-click approve + send (no session auth — token is the key)
router.get('/approve/:token', async (req, res) => {
  try {
    const draft = await queryOne(
      `SELECT d.*, c.name as company_name FROM drafts d
       LEFT JOIN companies c ON c.id = d.company_id
       WHERE d.approve_token = $1`,
      [req.params.token]
    );

    if (!draft) return res.send(confirmPage('Not Found', 'This draft does not exist or the link has expired.'));
    if (draft.status !== 'pending') return res.send(confirmPage('Already Processed', `This draft was already <strong>${draft.status}</strong>.`));

    if (!draft.investor_email) {
      await execute('UPDATE drafts SET status = $1 WHERE id = $2', ['approved_manual', draft.id]);
      return res.send(confirmPage(
        'Draft Approved',
        `No email address on file for <strong>${draft.investor_name}</strong>. The draft is marked approved — send it manually via LinkedIn or copy from the Tower.`
      ));
    }

    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
      to: draft.investor_email,
      subject: draft.subject,
      text: draft.body,
    });

    if (error) throw new Error(JSON.stringify(error));
    await execute('UPDATE drafts SET status = $1 WHERE id = $2', ['sent', draft.id]);
    return res.send(confirmPage(
      'Sent',
      `Your message to <strong>${draft.investor_name}</strong> (${draft.investor_email}) has been sent.`
    ));
  } catch (err) {
    return res.status(500).send(confirmPage('Error', `Failed to send: ${err.message}`));
  }
});

// GET /api/drafts/skip/:token — one-click skip (no session auth — token is the key)
router.get('/skip/:token', async (req, res) => {
  const draft = await queryOne('SELECT id, investor_name FROM drafts WHERE approve_token = $1', [req.params.token]);
  if (!draft) return res.send(confirmPage('Not Found', 'Draft not found.'));
  await execute('UPDATE drafts SET status = $1 WHERE id = $2', ['skipped', draft.id]);
  return res.send(confirmPage('Skipped', `Draft for <strong>${draft.investor_name}</strong> has been skipped.`));
});

// POST /api/drafts/:id/skip — UI skip (requires session auth)
router.post('/:id/skip', async (req, res) => {
  await execute('UPDATE drafts SET status = $1 WHERE id = $2', ['skipped', req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
