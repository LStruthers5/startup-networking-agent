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

// One-click InMail flow: opened from the briefing email (or the approve link when no email exists),
// this page auto-copies the draft to the clipboard and forwards straight to the person's LinkedIn.
// If the browser blocks the silent clipboard write (needs a user gesture in some browsers), it falls
// back to a visible copy button instead of redirecting under the user.
function inmailPage(draft) {
  const linkedinUrl = draft.linkedin_url
    || `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(draft.investor_name || '')}`;
  // Prefer the dedicated InMail variant; fall back to body for older single-draft rows.
  const inmailText = draft.inmail_body || draft.body || '';
  const bodyJs = JSON.stringify(inmailText);
  const urlJs = JSON.stringify(linkedinUrl);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${pageStyle}</style></head><body>
<div class="box">
  <h1>InMail for ${draft.investor_name || 'your contact'}</h1>
  <p class="sub" id="statusLine">Copying draft to your clipboard&hellip;</p>
  <div class="draft-box" id="draftText">${inmailText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  <div class="actions">
    <button class="btn btn-copy" id="copyBtn" style="display:none" onclick="manualCopy()">Copy Message</button>
    <a class="btn btn-primary" href="${linkedinUrl}">Open LinkedIn</a>
    <a class="btn btn-secondary" href="${APP_URL()}/api/drafts/replied/${draft.approve_token}">They replied — mark it</a>
    <a class="btn btn-secondary" href="${APP_URL()}">Back to Tower</a>
  </div>
</div>
<script>
const DRAFT = ${bodyJs};
const LINKEDIN = ${urlJs};
function manualCopy() {
  navigator.clipboard.writeText(DRAFT).then(() => {
    document.getElementById('statusLine').textContent = 'Copied — opening LinkedIn…';
    setTimeout(() => { location.href = LINKEDIN; }, 700);
  });
}
navigator.clipboard.writeText(DRAFT).then(() => {
  document.getElementById('statusLine').textContent = 'Draft copied — taking you to LinkedIn…';
  setTimeout(() => { location.href = LINKEDIN; }, 1200);
}).catch(() => {
  document.getElementById('statusLine').textContent = 'Click Copy Message, then Open LinkedIn.';
  document.getElementById('copyBtn').style.display = 'inline-block';
});
</script>
</body></html>`;
}

// Email preview-then-send: click 1 opens this page (draft revealed for the first time), click 2 on
// "Send this email now" actually sends via the approve endpoint. Keeps the briefing email itself
// free of draft text — you don't see the message until you choose to act on it.
function emailPreviewPage(draft) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${pageStyle}</style></head><body>
<div class="box">
  <h1>Email to ${draft.investor_name || 'your contact'}</h1>
  <p class="sub">To: ${draft.investor_email} &nbsp;·&nbsp; Subject: ${(draft.subject || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
  <div class="draft-box">${(draft.body || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  <div class="actions">
    <a class="btn btn-primary" href="${APP_URL()}/api/drafts/approve/${draft.approve_token}">Send this email now</a>
    <a class="btn btn-secondary" href="${APP_URL()}/api/drafts/inmail/${draft.approve_token}">Send as LinkedIn InMail instead</a>
    <a class="btn btn-secondary" href="${APP_URL()}/api/drafts/skip/${draft.approve_token}">Skip</a>
  </div>
</div>
</body></html>`;
}

// GET /api/drafts/email/:token — preview an email draft before sending (token is the auth)
router.get('/email/:token', async (req, res) => {
  const draft = await queryOne(
    `SELECT d.*, c.name as company_name FROM drafts d
     LEFT JOIN companies c ON c.id=d.company_id WHERE d.approve_token = $1`,
    [req.params.token]
  );
  if (!draft) return res.send(confirmPage('Not Found', 'This draft does not exist or the link has expired.'));
  if (draft.status !== 'pending') return res.send(confirmPage('Already Processed', `This draft was already <strong>${draft.status}</strong>.`));
  if (!draft.investor_email) return res.send(inmailPage(draft)); // no address → LinkedIn is the only path
  return res.send(emailPreviewPage(draft));
});

// GET /api/drafts — list drafts by status
router.get('/', async (req, res) => {
  const status = req.query.status || 'pending';
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const rows = await query(
    `SELECT d.*, c.name as company_name
     FROM drafts d
     LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.status = $1
     ORDER BY (d.investor_email IS NOT NULL AND d.investor_email != '') DESC, d.created_at DESC
     LIMIT $2`,
    [status, limit]
  );
  res.json(rows);
});

// GET /api/drafts/log — every draft across all statuses, newest first, with counts —
// the full outreach history, not just what's currently pending.
router.get('/log', async (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit) || 100);
  const [items, counts] = await Promise.all([
    query(
      `SELECT d.*, c.name as company_name
       FROM drafts d
       LEFT JOIN companies c ON c.id = d.company_id
       ORDER BY d.created_at DESC
       LIMIT $1`,
      [limit]
    ),
    query(`SELECT status, COUNT(*) AS n FROM drafts GROUP BY status`),
  ]);
  const countMap = { pending: 0, sent: 0, skipped: 0, approved_manual: 0 };
  for (const row of counts) countMap[row.status] = parseInt(row.n);
  res.json({ counts: countMap, items });
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
      return res.send(inmailPage(draft));
    }

    const { sendDraftEmail } = require('../email');
    await sendDraftEmail(draft);
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

// GET /api/drafts/cancel-auto-send/:token — no-session cancel link for the auto-send email notice
router.get('/cancel-auto-send/:token', async (req, res) => {
  const draft = await queryOne('SELECT id, investor_name, scheduled_send_at FROM drafts WHERE approve_token = $1', [req.params.token]);
  if (!draft) return res.send(confirmPage('Not Found', 'Draft not found.'));
  if (!draft.scheduled_send_at) {
    return res.send(confirmPage('Already Handled', `This draft for <strong>${draft.investor_name}</strong> isn't scheduled to auto-send (already sent, cancelled, or skipped).`));
  }
  await execute('UPDATE drafts SET scheduled_send_at = NULL WHERE id = $1', [draft.id]);
  return res.send(confirmPage('Auto-Send Cancelled', `The scheduled send to <strong>${draft.investor_name}</strong> is cancelled. It's now a normal pending draft — approve or skip it manually anytime.`));
});

// Shared by the UI button and the email link. LinkedIn replies can't be auto-detected (no API),
// so the user marks them — same downstream effects as auto-detection: replied_at set, investor
// bumped toward warm, and a reply_received signal in the river. Marking a still-pending draft
// replied implies it was actually sent, so status flips to approved_manual for coherent stats.
async function markDraftReplied(draft) {
  const { nowText } = require('../db');
  const { executeAgent } = require('../agent-control');
  await execute(
    `UPDATE drafts SET replied_at=$1, reply_source='manually-marked',
     status=CASE WHEN status='pending' THEN 'approved_manual' ELSE status END WHERE id=$2`,
    [nowText(), draft.id]
  );
  await execute(
    `UPDATE investors SET relationship_status='warm', last_touched=$1
     WHERE LOWER(name)=LOWER($2) AND relationship_status IN ('cold','outreach_sent')`,
    [nowText(), draft.investor_name]
  );
  await executeAgent('reply-detector', {
    trigger: 'manual',
    input: { draft_id: draft.id, source: 'manually-marked' },
  }, async () => [{
    title: `${draft.investor_name} replied${draft.company_name ? ` — re: ${draft.company_name}` : ''}`,
    summary: `Marked replied by you (${(draft.channel || 'inmail') === 'inmail' ? 'LinkedIn' : 'email'} conversation happening outside the app). Respond and log the next step.`,
    signal_type: 'reply_received',
    entity_type: 'investor',
    company_id: draft.company_id || null,
    confidence: 1,
    actionable: true,
    data: { draft_id: draft.id, reply_source: 'manually-marked' },
  }]).catch(err => console.warn('[MarkReplied] Signal logging failed:', err.message));
}

// GET /api/drafts/inmail/:token — one-click copy-and-open-LinkedIn page from the briefing email.
// Visiting it counts as acting on the draft: a pending draft flips to approved_manual (same
// semantics the approve link's no-email branch has always had), so the pending queue stays honest.
router.get('/inmail/:token', async (req, res) => {
  const draft = await queryOne(
    `SELECT d.*, c.name AS company_name FROM drafts d
     LEFT JOIN companies c ON c.id=d.company_id WHERE d.approve_token = $1`,
    [req.params.token]
  );
  if (!draft) return res.send(confirmPage('Not Found', 'This draft does not exist or the link has expired.'));
  if (draft.status === 'pending') {
    await execute(`UPDATE drafts SET status='approved_manual' WHERE id=$1`, [draft.id]);
    const sourceSignal = draft.company_id ? await queryOne('SELECT id,run_id FROM agent_signals WHERE company_id=$1 ORDER BY created_at DESC LIMIT 1', [draft.company_id]) : null;
    await execute(
      `INSERT INTO agent_outcomes (run_id,signal_id,company_id,outcome_type,notes,data_json)
       VALUES ($1,$2,$3,'draft_approved',$4,$5)`,
      [sourceSignal?.run_id || null, sourceSignal?.id || null, draft.company_id, draft.investor_name || '', JSON.stringify({ draft_id: draft.id, delivery: 'manual-linkedin' })]
    ).catch(() => {});
  }
  return res.send(inmailPage(draft));
});

// GET /api/drafts/replied/:token — one-click mark-replied from the briefing email (token is the auth)
router.get('/replied/:token', async (req, res) => {
  const draft = await queryOne(
    `SELECT d.*, c.name AS company_name FROM drafts d
     LEFT JOIN companies c ON c.id=d.company_id WHERE d.approve_token = $1`,
    [req.params.token]
  );
  if (!draft) return res.send(confirmPage('Not Found', 'Draft not found.'));
  if (draft.replied_at) return res.send(confirmPage('Already Marked', `${draft.investor_name} was already marked as replied.`));
  await markDraftReplied(draft);
  return res.send(confirmPage('Marked as Replied', `<strong>${draft.investor_name}</strong> is now tracked as replied — relationship bumped to warm.`));
});

// POST /api/drafts/:id/mark-replied — UI variant (requires session auth)
router.post('/:id/mark-replied', async (req, res) => {
  const draft = await queryOne(
    `SELECT d.*, c.name AS company_name FROM drafts d
     LEFT JOIN companies c ON c.id=d.company_id WHERE d.id=$1`,
    [req.params.id]
  );
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (draft.replied_at) return res.status(400).json({ error: 'Already marked as replied' });
  await markDraftReplied(draft);
  res.json({ ok: true });
});

// POST /api/drafts/:id/cancel-auto-send — UI cancel (requires session auth)
router.post('/:id/cancel-auto-send', async (req, res) => {
  const draft = await queryOne('SELECT id, scheduled_send_at FROM drafts WHERE id=$1', [req.params.id]);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  if (!draft.scheduled_send_at) return res.status(400).json({ error: 'This draft is not scheduled to auto-send' });
  await execute('UPDATE drafts SET scheduled_send_at = NULL WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
