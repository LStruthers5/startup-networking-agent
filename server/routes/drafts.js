const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, queryOne, execute } = require('../db');

function APP_URL() {
  if (process.env.APP_URL) return process.env.APP_URL;
  // Railway injects this automatically — no manual env var needed
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return 'http://localhost:3000';
}

const pageStyle = `
  body { font-family: system-ui, sans-serif; background: #edf5f9; color: #0d1e30; margin: 0; padding: 32px 16px; }
  .box { background: #fff; border: 1px solid #bdd6e6; border-radius: 12px; padding: 36px; max-width: 560px; margin: 0 auto; box-shadow: 0 4px 24px rgba(13,30,48,.08); }
  h1 { font-size: 20px; margin: 0 0 8px; color: #0d7ea5; }
  .sub { color: #5a7f9e; font-size: 14px; margin: 0 0 20px; }
  .draft-box { background: #f0f7fa; border-left: 4px solid #0d7ea5; border-radius: 0 8px 8px 0; padding: 16px 18px; font-size: 14px; line-height: 1.7; white-space: pre-wrap; margin-bottom: 20px; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .btn { display: inline-block; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; cursor: pointer; border: none; }
  .btn-primary { background: #0d1e30; color: #fff; }
  .btn-secondary { background: #fff; color: #0d7ea5; border: 1px solid #bdd6e6; }
  .btn-copy { background: #0d7ea5; color: #fff; }
  .back { font-size: 13px; color: #5a7f9e; }
  .back a { color: #0d7ea5; }`;

function confirmPage(heading, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${pageStyle}</style></head><body>
<div class="box">
  <h1>${heading}</h1>
  <p class="sub">${message}</p>
  <p class="back"><a href="${APP_URL()}">Back to Tower</a></p>
</div></body></html>`;
}

function noEmailPage(draft) {
  const linkedinUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent((draft.investor_name || '') + ' ' + (draft.investor_firm || ''))}`;
  const escaped = (draft.body || '').replace(/`/g, '\\`').replace(/\\/g, '\\\\');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${pageStyle}</style></head><body>
<div class="box">
  <h1>Draft Ready — No Email Found</h1>
  <p class="sub">No email address on file for <strong>${draft.investor_name}</strong>. Copy the message below and send via LinkedIn or email.</p>
  <div class="draft-box" id="draftText">${(draft.body || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  <div class="actions">
    <button class="btn btn-copy" onclick="copyDraft()">Copy Message</button>
    <a class="btn btn-secondary" href="${linkedinUrl}" target="_blank">Find on LinkedIn</a>
    <a class="btn btn-primary" href="${APP_URL()}">Back to Tower</a>
  </div>
  <p id="copyConfirm" style="color:#0d7ea5;font-size:13px;display:none">Copied to clipboard</p>
</div>
<script>
function copyDraft() {
  navigator.clipboard.writeText(\`${escaped}\`).then(() => {
    document.getElementById('copyConfirm').style.display = 'block';
  });
}
</script>
</body></html>`;
}

// GET /api/drafts — list drafts by status
router.get('/', async (req, res) => {
  const status = req.query.status || 'pending';
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const rows = await query(
    `SELECT d.*, c.name as company_name
     FROM drafts d
     LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.status = $1
     ORDER BY d.created_at DESC
     LIMIT $2`,
    [status, limit]
  );
  res.json(rows);
});

// PATCH /api/drafts/:id — update status
router.patch('/:id', async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending','skipped','approved_manual','sent'];
  if (!status || !allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const draft = await queryOne('SELECT id, company_id, investor_name FROM drafts WHERE id=$1', [req.params.id]);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  await execute('UPDATE drafts SET status=$1 WHERE id=$2', [status, req.params.id]);
  if (status === 'skipped') {
    const sourceSignal = draft.company_id ? await queryOne('SELECT id,run_id FROM agent_signals WHERE company_id=$1 ORDER BY created_at DESC LIMIT 1', [draft.company_id]) : null;
    await execute(
      `INSERT INTO agent_outcomes (run_id,signal_id,company_id,outcome_type,notes,data_json)
       VALUES ($1,$2,$3,'draft_skipped',$4,$5)`,
      [sourceSignal?.run_id||null, sourceSignal?.id||null, draft.company_id, draft.investor_name||'', JSON.stringify({ draft_id: draft.id })]
    ).catch(() => {});
  }
  res.json({ ok: true });
});

// POST /api/drafts — save a draft from the UI
router.post('/', async (req, res) => {
  const { company_id, investor_name, investor_email, subject, body, channel, linkedin_url } = req.body;
  if (!body || !subject) return res.status(400).json({ error: 'subject and body required' });

  const token = crypto.randomBytes(32).toString('hex');
  const result = await execute(
    `INSERT INTO drafts (company_id, investor_name, investor_email, subject, body, approve_token, channel, linkedin_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [company_id || null, investor_name || '', investor_email || null, subject, body, token,
     channel || 'inmail', linkedin_url || '']
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
      const sourceSignal = draft.company_id ? await queryOne('SELECT id,run_id FROM agent_signals WHERE company_id=$1 ORDER BY created_at DESC LIMIT 1', [draft.company_id]) : null;
      await execute(
        `INSERT INTO agent_outcomes (run_id,signal_id,company_id,outcome_type,notes,data_json)
         VALUES ($1,$2,$3,'draft_approved',$4,$5)`,
        [sourceSignal?.run_id || null, sourceSignal?.id || null, draft.company_id, draft.investor_name || '', JSON.stringify({ draft_id: draft.id, delivery: 'manual' })]
      );
      return res.send(noEmailPage(draft));
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
    const sourceSignal = draft.company_id ? await queryOne('SELECT id,run_id FROM agent_signals WHERE company_id=$1 ORDER BY created_at DESC LIMIT 1', [draft.company_id]) : null;
    await execute(
      `INSERT INTO agent_outcomes (run_id,signal_id,company_id,outcome_type,notes,data_json)
       VALUES ($1,$2,$3,'outreach_sent',$4,$5)`,
      [sourceSignal?.run_id || null, sourceSignal?.id || null, draft.company_id, draft.investor_name || '', JSON.stringify({ draft_id: draft.id, delivery: 'email' })]
    );
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
  const draft = await queryOne('SELECT id, investor_name, company_id FROM drafts WHERE approve_token = $1', [req.params.token]);
  if (!draft) return res.send(confirmPage('Not Found', 'Draft not found.'));
  await execute('UPDATE drafts SET status = $1 WHERE id = $2', ['skipped', draft.id]);
  const sourceSignal = draft.company_id ? await queryOne('SELECT id,run_id FROM agent_signals WHERE company_id=$1 ORDER BY created_at DESC LIMIT 1', [draft.company_id]) : null;
  await execute(
    `INSERT INTO agent_outcomes (run_id,signal_id,company_id,outcome_type,notes,data_json)
     VALUES ($1,$2,$3,'draft_skipped',$4,$5)`,
    [sourceSignal?.run_id || null, sourceSignal?.id || null, draft.company_id, draft.investor_name || '', JSON.stringify({ draft_id: draft.id })]
  );
  return res.send(confirmPage('Skipped', `Draft for <strong>${draft.investor_name}</strong> has been skipped.`));
});

// POST /api/drafts/:id/skip — UI skip (requires session auth)
router.post('/:id/skip', async (req, res) => {
  const draft = await queryOne('SELECT * FROM drafts WHERE id=$1', [req.params.id]);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  await execute('UPDATE drafts SET status = $1 WHERE id = $2', ['skipped', req.params.id]);
  const sourceSignal = draft.company_id ? await queryOne('SELECT id,run_id FROM agent_signals WHERE company_id=$1 ORDER BY created_at DESC LIMIT 1', [draft.company_id]) : null;
  await execute(
    `INSERT INTO agent_outcomes (run_id,signal_id,company_id,outcome_type,notes,data_json)
     VALUES ($1,$2,$3,'draft_skipped',$4,$5)`,
    [sourceSignal?.run_id || null, sourceSignal?.id || null, draft.company_id, draft.investor_name || '', JSON.stringify({ draft_id: draft.id })]
  );
  res.json({ ok: true });
});

module.exports = router;
