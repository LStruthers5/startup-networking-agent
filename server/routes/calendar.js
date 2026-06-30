const express = require('express');
const router = express.Router();
const gcal = require('../google-calendar');

function APP_URL() {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return 'http://localhost:3000';
}

// GET /api/calendar/status
router.get('/status', async (req, res) => {
  res.json(await gcal.getStatus());
});

// GET /api/calendar/connect — redirects to Google consent screen
router.get('/connect', (req, res) => {
  if (!gcal.isConfigured()) {
    return res.status(400).send('Google Calendar is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
  res.redirect(gcal.getAuthUrl());
});

// GET /api/calendar/oauth/callback
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');
    const email = await gcal.handleCallback(code);
    res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">
      <h2>Calendar connected ✓</h2>
      <p>${email} is now linked. You can close this tab.</p>
      <a href="${APP_URL()}">Back to Networking River</a>
    </body></html>`);
  } catch (err) {
    res.status(500).send('Failed to connect: ' + err.message);
  }
});

// POST /api/calendar/disconnect
router.post('/disconnect', async (req, res) => {
  await gcal.disconnect();
  res.json({ ok: true });
});

// GET /api/calendar/upcoming
router.get('/upcoming', async (req, res) => {
  try {
    const days = Math.min(30, parseInt(req.query.days) || 7);
    res.json(await gcal.listUpcomingEvents(days));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
