const { queryOne, execute, nowText } = require('./db');

function APP_URL() {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return 'http://localhost:3000';
}

function redirectUri() {
  return `${APP_URL()}/api/calendar/oauth/callback`;
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
    scope: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/userinfo.email'],
  });
}

async function handleCallback(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const { google } = require('googleapis');
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data: userInfo } = await oauth2.userinfo.get();

  const existing = await queryOne(`SELECT id FROM calendar_connections WHERE owner_id='local' LIMIT 1`);
  const expiry = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;
  if (existing) {
    await execute(
      `UPDATE calendar_connections SET account_email=$1, access_token=$2,
       refresh_token=COALESCE($3, refresh_token), token_expiry=$4, scope=$5, connected_at=$6 WHERE id=$7`,
      [userInfo.email, tokens.access_token, tokens.refresh_token || null, expiry, tokens.scope || '', nowText(), existing.id]
    );
  } else {
    await execute(
      `INSERT INTO calendar_connections (provider, account_email, access_token, refresh_token, token_expiry, scope)
       VALUES ('google',$1,$2,$3,$4,$5)`,
      [userInfo.email, tokens.access_token, tokens.refresh_token || null, expiry, tokens.scope || '']
    );
  }
  return userInfo.email;
}

async function getStatus() {
  const conn = await queryOne(`SELECT account_email, connected_at FROM calendar_connections WHERE owner_id='local' LIMIT 1`);
  return {
    configured: isConfigured(),
    connected: Boolean(conn),
    account_email: conn?.account_email || null,
    connected_at: conn?.connected_at || null,
  };
}

async function getAuthorizedClient() {
  const conn = await queryOne(`SELECT * FROM calendar_connections WHERE owner_id='local' LIMIT 1`);
  if (!conn || !conn.refresh_token) return null;
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: conn.refresh_token, access_token: conn.access_token });
  client.on('tokens', async tokens => {
    if (tokens.access_token) {
      const expiry = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;
      await execute(`UPDATE calendar_connections SET access_token=$1, token_expiry=$2 WHERE id=$3`, [tokens.access_token, expiry, conn.id]);
    }
  });
  return client;
}

// Returns upcoming events with attendee emails/names for the next N days
async function listUpcomingEvents(days = 7) {
  const client = await getAuthorizedClient();
  if (!client) return [];
  const { google } = require('googleapis');
  const calendar = google.calendar({ version: 'v3', auth: client });
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 86400000).toISOString();
  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin, timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });
  return (data.items || []).map(ev => ({
    id: ev.id,
    title: ev.summary || '(untitled event)',
    start: ev.start?.dateTime || ev.start?.date,
    location: ev.location || '',
    attendees: (ev.attendees || []).map(a => ({ email: a.email, name: a.displayName || '' })),
  }));
}

async function disconnect() {
  await execute(`DELETE FROM calendar_connections WHERE owner_id='local'`);
}

module.exports = { isConfigured, getAuthUrl, handleCallback, getStatus, listUpcomingEvents, disconnect };
