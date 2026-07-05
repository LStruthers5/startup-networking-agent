const express = require('express');
const router = express.Router();
const gmail = require('../gmail');

function APP_URL() {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return 'http://localhost:3000';
}

// GET /api/gmail/status
router.get('/status', async (req, res) => {
  res.json(await gmail.getStatus());
});

// GET /api/gmail/connect — redirects to Google consent screen
router.get('/connect', (req, res) => {
  if (!gmail.isConfigured()) {
    return res.status(400).send('Gmail is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
  res.redirect(gmail.getAuthUrl());
});

// GET /api/gmail/oauth/callback
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');
    const email = await gmail.handleCallback(code);
    res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">
      <h2>Gmail connected ✓</h2>
      <p>${email} is now linked. You can close this tab.</p>
      <a href="${APP_URL()}">Back to Networking River</a>
    </body></html>`);
  } catch (err) {
    res.status(500).send('Failed to connect: ' + err.message);
  }
});

// POST /api/gmail/disconnect
router.post('/disconnect', async (req, res) => {
  await gmail.disconnect();
  res.json({ ok: true });
});

module.exports = router;
