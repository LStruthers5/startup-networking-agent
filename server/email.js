function getResend() {
  const { Resend } = require('resend');
  return new Resend(process.env.RESEND_API_KEY);
}

const FROM = 'Networking Tower <onboarding@resend.dev>';
const RECIPIENT = () => process.env.RECIPIENT_EMAIL || 'lukestruthers22@gmail.com';
const APP_URL = () => process.env.APP_URL || 'http://localhost:3000';

function dateStr() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function buildMorningHtml({ pendingDrafts = [], upcomingEvents = [], overdueActions = [], pipelineText = '' }) {
  const teal = '#0d7ea5';
  const deepNavy = '#0a4666';
  const danger = '#c13333';
  const muted = '#5a7f9e';
  const bg = '#edf5f9';
  const surface = '#ffffff';
  const border = '#bdd6e6';
  const text = '#0d1e30';

  function sectionHead(label, color) {
    return `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:${color};margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid ${border}">${label}</div>`;
  }

  let sections = '';

  // ── Approve These ────────────────────────────────────────────────────────
  if (pendingDrafts.length > 0) {
    const cards = pendingDrafts.map(d => `
      <div style="background:${bg};border:1px solid ${border};border-radius:8px;padding:16px 18px;margin-bottom:10px">
        <div style="font-weight:700;font-size:14px;color:${text};margin-bottom:2px">
          ${d.investor_name || 'Unknown Contact'}${d.company_name ? ` &mdash; re: ${d.company_name}` : ''}
        </div>
        <div style="font-size:12px;color:${muted};margin-bottom:10px">Subject: ${d.subject}</div>
        <div style="font-size:13px;color:${text};line-height:1.65;border-left:3px solid ${teal};padding-left:12px;margin-bottom:14px;white-space:pre-wrap">${d.body.slice(0, 400)}${d.body.length > 400 ? '\n\n[…full message in Tower]' : ''}</div>
        <div>
          <a href="${APP_URL()}/api/drafts/approve/${d.approve_token}"
             style="background:${teal};color:#fff;padding:9px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;margin-right:10px;display:inline-block">
            Approve &amp; Send
          </a>
          <a href="${APP_URL()}/api/drafts/skip/${d.approve_token}"
             style="background:${surface};color:${muted};padding:9px 18px;border-radius:6px;text-decoration:none;font-size:13px;border:1px solid ${border};display:inline-block">
            Skip
          </a>
          ${!d.investor_email ? `<div style="margin-top:8px;font-size:11px;color:${danger}">No email on file — approve will mark for manual send</div>` : ''}
        </div>
      </div>`).join('');

    sections += `<div style="margin-bottom:28px">${sectionHead('Approve These Outreaches', teal)}${cards}</div>`;
  }

  // ── Events This Week ─────────────────────────────────────────────────────
  if (upcomingEvents.length > 0) {
    const rows = upcomingEvents.map(e => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border:1px solid ${border};border-radius:8px;margin-bottom:8px;background:${surface}">
        <div style="flex:1;min-width:0;margin-right:12px">
          <div style="font-weight:600;font-size:13px;color:${text}">${e.title}</div>
          <div style="font-size:12px;color:${muted};margin-top:2px">${e.event_date || ''}${e.location ? ' &middot; ' + e.location : ''}</div>
        </div>
        ${e.event_url
          ? `<a href="${e.event_url}" style="background:${bg};color:${teal};padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700;border:1px solid ${border};white-space:nowrap">Sign Up</a>`
          : ''}
      </div>`).join('');

    sections += `<div style="margin-bottom:28px">${sectionHead('Events This Week', deepNavy)}${rows}</div>`;
  }

  // ── On Your Radar ────────────────────────────────────────────────────────
  if (overdueActions.length > 0) {
    const rows = overdueActions.map(a => `
      <div style="padding:10px 12px;border-left:3px solid ${danger};margin-bottom:6px;font-size:13px;color:${text};background:${surface};border-radius:0 6px 6px 0">
        <strong>${a.company_name}</strong> &mdash; ${a.suggested_action}
        <span style="color:${danger};font-size:11px;font-weight:700;margin-left:8px">OVERDUE</span>
      </div>`).join('');

    sections += `<div style="margin-bottom:28px">${sectionHead('On Your Radar', danger)}${rows}</div>`;
  }

  // ── Pipeline Intel ───────────────────────────────────────────────────────
  if (pipelineText) {
    sections += `
      <div style="margin-bottom:28px">
        ${sectionHead("Today's Pipeline", muted)}
        <pre style="white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:13px;line-height:1.75;color:${text};margin:0">${pipelineText.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
      </div>`;
  }

  if (!sections) {
    sections = `<p style="color:${muted};font-size:14px;text-align:center;padding:24px 0">The river is quiet today &mdash; no pending drafts or events.</p>`;
  }

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
</head><body style="margin:0;padding:0;background:#d4eaf5;font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:640px;margin:32px auto;background:${surface};border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(13,30,48,.12)">

  <div style="background:linear-gradient(135deg,#0a4666 0%,#0d7ea5 60%,#22d3ee 100%);padding:28px 32px">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.6);margin-bottom:6px">NETWORKING TOWER</div>
    <div style="font-size:22px;font-weight:700;color:#fff;margin-bottom:4px">Morning Briefing</div>
    <div style="font-size:13px;color:rgba(255,255,255,.7)">${dateStr()}</div>
  </div>

  <div style="padding:28px 32px">${sections}</div>

  <div style="padding:16px 32px;border-top:1px solid ${border};font-size:11px;color:${muted};text-align:center">
    Networking Tower &middot; Auto-generated &middot;
    <a href="${APP_URL()}" style="color:${teal};text-decoration:none">Open Tower</a>
  </div>
</div></body></html>`;
}

async function sendMorningBriefing({ pendingDrafts, upcomingEvents, overdueActions, pipelineText, companyIds }) {
  const resend = getResend();
  const { execute } = require('./db');
  const recipient = RECIPIENT();

  const subject = `Morning Briefing — ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const html = buildMorningHtml({ pendingDrafts, upcomingEvents, overdueActions, pipelineText });

  const { data, error } = await resend.emails.send({ from: FROM, to: recipient, subject, html });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);

  await execute(
    `INSERT INTO email_log (email_type, recipient, subject, status, resend_id, company_ids)
     VALUES ('morning_briefing', $1, $2, 'sent', $3, $4)`,
    [recipient, subject, data?.id || null, (companyIds || []).join(',')]
  );

  return data;
}

async function sendWeeklyRecap(agentOutput) {
  const resend = getResend();
  const { execute } = require('./db');
  const recipient = RECIPIENT();

  const subject = `Weekly Recap — Week of ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#d4eaf5;font-family:system-ui,sans-serif">
<div style="max-width:640px;margin:32px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(13,30,48,.12)">
  <div style="background:linear-gradient(135deg,#0a4666,#0d7ea5);padding:28px 32px">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.6);margin-bottom:6px">NETWORKING TOWER</div>
    <div style="font-size:22px;font-weight:700;color:#fff">Weekly Recap</div>
  </div>
  <div style="padding:28px 32px">
    <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.75;color:#0d1e30;margin:0">${agentOutput.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
  </div>
</div></body></html>`;

  const { data, error } = await resend.emails.send({ from: FROM, to: recipient, subject, html });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);

  await execute(
    `INSERT INTO email_log (email_type, recipient, subject, status, resend_id) VALUES ('weekly_recap', $1, $2, 'sent', $3)`,
    [recipient, subject, data?.id || null]
  );

  return data;
}

module.exports = { sendMorningBriefing, sendWeeklyRecap };
