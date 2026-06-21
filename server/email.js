function getResend() {
  const { Resend } = require('resend');
  return new Resend(process.env.RESEND_API_KEY);
}

const FROM = 'Networking Tower <onboarding@resend.dev>';
const RECIPIENT = () => process.env.RECIPIENT_EMAIL || 'lukestruthers22@gmail.com';
function APP_URL() {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return 'http://localhost:3000';
}

function dateStr() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function buildMorningHtml({ pendingDrafts = [], upcomingEvents = [], overdueActions = [], pipelineText = '', newSignals = [], readyToReach = [] }) {
  const green = '#2f9e44';
  const deepGreen = '#16351f';
  const danger = '#c13333';
  const muted = '#4a7c59';
  const bg = '#eef6e8';
  const surface = '#ffffff';
  const border = '#b2d9bc';
  const text = '#0d1e30';

  function sectionHead(label, color) {
    return `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:${color};margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid ${border}">${label}</div>`;
  }

  let sections = '';

  // ── InMails Ready to Send ─────────────────────────────────────────────────
  if (pendingDrafts.length > 0) {
    const cards = pendingDrafts.map(d => {
      const isInmail = (d.channel || 'inmail') === 'inmail';
      const channelBadge = isInmail
        ? `<span style="background:#0a66c2;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;margin-left:8px">LinkedIn InMail</span>`
        : `<span style="background:${muted};color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;margin-left:8px">Email</span>`;
      const actionBtn = isInmail
        ? `<a href="${d.linkedin_url || 'https://linkedin.com'}" target="_blank"
             style="background:#0a66c2;color:#fff;padding:9px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;margin-right:10px;display:inline-block">
             Open LinkedIn Profile
           </a>`
        : `<a href="${APP_URL()}/api/drafts/approve/${d.approve_token}"
             style="background:${green};color:#fff;padding:9px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;margin-right:10px;display:inline-block">
             Approve &amp; Send
           </a>`;

      return `
      <div style="background:${bg};border:1px solid ${border};border-radius:8px;padding:16px 18px;margin-bottom:10px">
        <div style="font-weight:700;font-size:14px;color:${text};margin-bottom:2px">
          ${d.investor_name || 'Unknown Contact'}${d.company_name ? ` &mdash; re: ${d.company_name}` : ''}${channelBadge}
        </div>
        <div style="font-size:12px;color:${muted};margin-bottom:10px">Subject: ${d.subject}</div>
        <div style="font-size:13px;color:${text};line-height:1.65;border-left:3px solid ${green};padding-left:12px;margin-bottom:14px;white-space:pre-wrap">${d.body}</div>
        <div>
          ${actionBtn}
          <a href="${APP_URL()}/api/drafts/skip/${d.approve_token}"
             style="background:${surface};color:${muted};padding:9px 18px;border-radius:6px;text-decoration:none;font-size:13px;border:1px solid ${border};display:inline-block">
            Skip
          </a>
        </div>
      </div>`;
    }).join('');

    sections += `<div style="margin-bottom:28px">${sectionHead('Your InMails Today', green)}${cards}</div>`;
  }

  // ── Companies Ready to Reach ──────────────────────────────────────────────
  if (readyToReach.length > 0) {
    const rows = readyToReach.map(c => `
      <div style="padding:12px 14px;border:1px solid ${border};border-radius:8px;margin-bottom:8px;background:${surface}">
        <div style="font-weight:600;font-size:13px;color:${text}">${c.name}
          ${c.sector ? `<span style="color:${muted};font-weight:400;font-size:12px"> &middot; ${c.sector}</span>` : ''}
          ${c.stage ? `<span style="color:${muted};font-weight:400;font-size:12px"> &middot; ${c.stage}</span>` : ''}
        </div>
        ${c.why ? `<div style="font-size:12px;color:${muted};margin-top:4px">${c.why}</div>` : ''}
      </div>`).join('');

    sections += `<div style="margin-bottom:28px">${sectionHead('Companies to Reach Out To', deepGreen)}${rows}</div>`;
  }

  // ── New Signals ───────────────────────────────────────────────────────────
  if (newSignals.length > 0) {
    const rows = newSignals.map(s => `
      <div style="padding:10px 12px;border-left:3px solid ${green};margin-bottom:6px;font-size:13px;color:${text};background:${surface};border-radius:0 6px 6px 0">
        ${s.company_name ? `<strong>${s.company_name}</strong> &mdash; ` : ''}${s.summary || s.title || ''}
        ${s.source_name ? `<span style="color:${muted};font-size:11px;margin-left:6px">via ${s.source_name}</span>` : ''}
      </div>`).join('');

    sections += `<div style="margin-bottom:28px">${sectionHead('Fresh Intelligence', muted)}${rows}</div>`;
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
          ? `<a href="${e.event_url}" style="background:${bg};color:${green};padding:7px 16px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700;border:1px solid ${border};white-space:nowrap">Sign Up</a>`
          : ''}
      </div>`).join('');

    sections += `<div style="margin-bottom:28px">${sectionHead('Events This Week', deepGreen)}${rows}</div>`;
  }

  // ── On Your Radar ────────────────────────────────────────────────────────
  if (overdueActions.length > 0) {
    const rows = overdueActions.map(a => `
      <div style="padding:10px 12px;border-left:3px solid ${danger};margin-bottom:6px;font-size:13px;color:${text};background:${surface};border-radius:0 6px 6px 0">
        <strong>${a.company_name}</strong> &mdash; ${a.suggested_action}
        <span style="color:${danger};font-size:11px;font-weight:700;margin-left:8px">OVERDUE</span>
      </div>`).join('');

    sections += `<div style="margin-bottom:28px">${sectionHead('Follow Up', danger)}${rows}</div>`;
  }

  // ── Pipeline Intel ───────────────────────────────────────────────────────
  if (pipelineText) {
    sections += `
      <div style="margin-bottom:28px">
        ${sectionHead("Pipeline Snapshot", muted)}
        <pre style="white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:13px;line-height:1.75;color:${text};margin:0">${pipelineText.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
      </div>`;
  }

  if (!sections) {
    sections = `<p style="color:${muted};font-size:14px;text-align:center;padding:24px 0">The river is quiet today &mdash; no pending drafts or events.</p>`;
  }

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
</head><body style="margin:0;padding:0;background:#c8e6c9;font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:640px;margin:32px auto;background:${surface};border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(13,48,20,.12)">

  <div style="background:linear-gradient(135deg,#16351f 0%,#2f9e44 70%,#8ce99a 100%);padding:28px 32px">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.6);margin-bottom:6px">NETWORKING RIVER</div>
    <div style="font-size:22px;font-weight:700;color:#fff;margin-bottom:4px">Morning Briefing</div>
    <div style="font-size:13px;color:rgba(255,255,255,.7)">${dateStr()}</div>
  </div>

  <div style="padding:28px 32px">${sections}</div>

  <div style="padding:16px 32px;border-top:1px solid ${border};font-size:11px;color:${muted};text-align:center">
    Networking River &middot; Auto-generated &middot;
    <a href="${APP_URL()}" style="color:${green};text-decoration:none">Open River</a>
  </div>
</div></body></html>`;
}

async function sendMorningBriefing({ pendingDrafts, upcomingEvents, overdueActions, pipelineText, companyIds, newSignals, readyToReach }) {
  const resend = getResend();
  const { execute, query } = require('./db');
  const recipient = RECIPIENT();

  // Pull fresh signals from last 24h if not provided
  if (!newSignals) {
    try {
      newSignals = await query(
        `SELECT s.summary, s.title, s.source_name, c.name AS company_name
         FROM agent_signals s LEFT JOIN companies c ON c.id = s.company_id
         WHERE s.status = 'new' AND s.actionable = true
           AND s.created_at >= to_char(NOW() - INTERVAL '24 hours', 'YYYY-MM-DD HH24:MI:SS')
           AND LENGTH(TRIM(COALESCE(s.summary,''))) >= 30
         ORDER BY s.confidence DESC LIMIT 6`
      );
    } catch (_) { newSignals = []; }
  }

  // Pull companies with strong intelligence and no recent draft
  if (!readyToReach) {
    try {
      readyToReach = await query(
        `SELECT c.name, c.sector, c.stage, ci.preference_fit AS why
         FROM companies c
         JOIN company_intelligence ci ON ci.company_id = c.id
         WHERE c.status NOT IN ('passed','archived')
           AND ci.confidence >= 0.6
           AND NOT EXISTS (
             SELECT 1 FROM drafts d
             WHERE d.company_id = c.id AND d.status = 'pending'
               AND d.created_at >= to_char(NOW() - INTERVAL '3 days','YYYY-MM-DD HH24:MI:SS')
           )
         ORDER BY ci.confidence DESC, c.score DESC NULLS LAST LIMIT 4`
      );
    } catch (_) { readyToReach = []; }
  }

  const subject = `Morning Briefing — ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const html = buildMorningHtml({ pendingDrafts, upcomingEvents, overdueActions, pipelineText, newSignals, readyToReach });

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
