function getResend() {
  const { Resend } = require('resend');
  return new Resend(process.env.RESEND_API_KEY);
}

const FROM = 'Networking Tower <onboarding@resend.dev>';
const RECIPIENT = process.env.RECIPIENT_EMAIL || 'lukestruthers22@gmail.com';

function wrapHtml(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e2e8f0; margin: 0; padding: 0; }
  .container { max-width: 640px; margin: 32px auto; background: #1a1d27; border-radius: 12px; overflow: hidden; }
  .header { background: linear-gradient(135deg, #2563eb, #7c3aed); padding: 28px 32px; }
  .header h1 { margin: 0; font-size: 20px; font-weight: 700; color: #fff; letter-spacing: -0.3px; }
  .header p { margin: 4px 0 0; font-size: 13px; color: rgba(255,255,255,0.75); }
  .body { padding: 28px 32px; }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; font-size: 14px; line-height: 1.7; color: #cbd5e1; margin: 0; }
  .footer { padding: 16px 32px; border-top: 1px solid #2d3148; font-size: 12px; color: #64748b; text-align: center; }
  strong { color: #93c5fd; }
  .pill { display: inline-block; background: #1e3a5f; color: #60a5fa; font-size: 11px; padding: 2px 8px; border-radius: 20px; margin: 0 2px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🗼 ${title}</h1>
    <p>Networking Tower v2 · ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </div>
  <div class="body">
    <pre>${bodyHtml}</pre>
  </div>
  <div class="footer">Networking Tower v2 · Auto-generated · <a href="#" style="color:#60a5fa">Manage Settings</a></div>
</div>
</body>
</html>`;
}

async function sendDailyOutreach(agentOutput, companyIds) {
  const resend = getResend();
  const db = require('./db');

  const subject = `Daily Outreach — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`;
  const html = wrapHtml('Daily Outreach Brief', agentOutput.replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  const { data, error } = await resend.emails.send({
    from: FROM,
    to: RECIPIENT,
    subject,
    html,
  });

  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);

  // Log to DB
  db.prepare(`
    INSERT INTO email_log (email_type, recipient, subject, status, resend_id, company_ids)
    VALUES ('daily_outreach', ?, ?, 'sent', ?, ?)
  `).run(RECIPIENT, subject, data?.id || null, (companyIds || []).join(','));

  // Mark companies as last_suggested
  if (companyIds && companyIds.length) {
    const stmt = db.prepare(`UPDATE companies SET last_suggested = datetime('now') WHERE id = ?`);
    for (const id of companyIds) stmt.run(id);
  }

  return data;
}

async function sendWeeklyRecap(agentOutput) {
  const resend = getResend();
  const db = require('./db');

  const subject = `Weekly Recap — Week of ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
  const html = wrapHtml('Weekly Recap', agentOutput.replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  const { data, error } = await resend.emails.send({
    from: FROM,
    to: RECIPIENT,
    subject,
    html,
  });

  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);

  db.prepare(`
    INSERT INTO email_log (email_type, recipient, subject, status, resend_id)
    VALUES ('weekly_recap', ?, ?, 'sent', ?)
  `).run(RECIPIENT, subject, data?.id || null);

  return data;
}

module.exports = { sendDailyOutreach, sendWeeklyRecap };
