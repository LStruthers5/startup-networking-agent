const { queryOne, execute, nowText } = require('./db');

function APP_URL() {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return 'http://localhost:3000';
}

function redirectUri() {
  return `${APP_URL()}/api/gmail/oauth/callback`;
}

function getOAuthClient() {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri()
  );
}

function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function getAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email'],
  });
}

async function handleCallback(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const { google } = require('googleapis');
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data: userInfo } = await oauth2.userinfo.get();

  const existing = await queryOne(`SELECT id FROM gmail_connections WHERE owner_id='local' LIMIT 1`);
  const expiry = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;
  if (existing) {
    await execute(
      `UPDATE gmail_connections SET account_email=$1, access_token=$2,
       refresh_token=COALESCE($3, refresh_token), token_expiry=$4, scope=$5, connected_at=$6 WHERE id=$7`,
      [userInfo.email, tokens.access_token, tokens.refresh_token || null, expiry, tokens.scope || '', nowText(), existing.id]
    );
  } else {
    await execute(
      `INSERT INTO gmail_connections (provider, account_email, access_token, refresh_token, token_expiry, scope)
       VALUES ('google',$1,$2,$3,$4,$5)`,
      [userInfo.email, tokens.access_token, tokens.refresh_token || null, expiry, tokens.scope || '']
    );
  }
  return userInfo.email;
}

async function getStatus() {
  const conn = await queryOne(`SELECT account_email, connected_at FROM gmail_connections WHERE owner_id='local' LIMIT 1`);
  return {
    configured: isConfigured(),
    connected: Boolean(conn),
    account_email: conn?.account_email || null,
    connected_at: conn?.connected_at || null,
  };
}

async function getAuthorizedClient() {
  const conn = await queryOne(`SELECT * FROM gmail_connections WHERE owner_id='local' LIMIT 1`);
  if (!conn || !conn.refresh_token) return null;
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: conn.refresh_token, access_token: conn.access_token });
  client.on('tokens', async tokens => {
    if (tokens.access_token) {
      const expiry = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;
      await execute(`UPDATE gmail_connections SET access_token=$1, token_expiry=$2 WHERE id=$3`, [tokens.access_token, expiry, conn.id]);
    }
  });
  return client;
}

// Decodes the plain-text body from a Gmail message payload, preferring text/plain parts.
function extractPlainText(payload) {
  if (!payload) return '';
  const decode = data => Buffer.from(data, 'base64').toString('utf8');
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decode(payload.body.data);
  if (Array.isArray(payload.parts)) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
    if (plain) return decode(plain.body.data);
    for (const part of payload.parts) {
      const nested = extractPlainText(part);
      if (nested) return nested;
    }
  }
  if (payload.body?.data) return decode(payload.body.data);
  return '';
}

// Strips quoted reply chains and common signature blocks, keeping just what the user actually wrote.
// The "On ... wrote:" header can wrap onto a second line for long names/addresses, so this allows the
// match to span up to a couple lines rather than requiring it fit on one line under a fixed length.
function stripQuotedAndSignature(text) {
  return text
    .split(/\n\s*On [\s\S]{0,200}?wrote:\s*\n/)[0]
    .split(/\n>.*$/m)[0]
    .split(/\n--\s*\n/)[0]
    .trim();
}

function headerValue(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// Returns recent inbox messages with lightweight metadata only (subject/from/snippet) — never full bodies.
async function listRecentInboxMessages(days = 3, limit = 40) {
  const client = await getAuthorizedClient();
  if (!client) return [];
  const { google } = require('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: client });
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: `in:inbox newer_than:${Math.max(1, days)}d`,
    maxResults: Math.min(100, limit),
  });
  const ids = (data.messages || []).slice(0, limit);
  const messages = [];
  for (const { id } of ids) {
    const { data: msg } = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
    messages.push({
      id: msg.id,
      subject: headerValue(msg.payload?.headers, 'Subject'),
      from: headerValue(msg.payload?.headers, 'From'),
      date: headerValue(msg.payload?.headers, 'Date'),
      snippet: msg.snippet || '',
    });
  }
  return messages;
}

// Returns recent Sent messages with full plain-text bodies (quotes/signatures stripped) for style learning.
// Fetches a wider pool than requested since short/near-empty replies (post-stripping) get filtered out —
// otherwise a run of one-line replies could starve the caller of enough real signal to learn from.
async function listRecentSentMessages(limit = 15) {
  const client = await getAuthorizedClient();
  if (!client) return [];
  const { google } = require('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: client });
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:sent',
    maxResults: Math.min(80, limit * 3),
  });
  const ids = data.messages || [];
  const messages = [];
  const MIN_BODY_LENGTH = 40;
  for (const { id } of ids) {
    if (messages.length >= limit) break;
    const { data: msg } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const body = stripQuotedAndSignature(extractPlainText(msg.payload));
    if (body.length >= MIN_BODY_LENGTH) {
      messages.push({
        subject: headerValue(msg.payload?.headers, 'Subject'),
        body: body.slice(0, 2000),
      });
    }
  }
  return messages;
}

async function disconnect() {
  await execute(`DELETE FROM gmail_connections WHERE owner_id='local'`);
}

module.exports = { isConfigured, getAuthUrl, handleCallback, getStatus, listRecentInboxMessages, listRecentSentMessages, disconnect };
