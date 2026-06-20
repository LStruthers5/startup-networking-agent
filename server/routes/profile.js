const express = require('express');
const router = express.Router();
const multer = require('multer');
const { query, queryOne, execute } = require('../db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/profile
router.get('/', async (req, res) => {
  try {
    const profile = await queryOne('SELECT * FROM user_profile ORDER BY id LIMIT 1');
    res.json(profile || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/profile — save editable fields
router.put('/', async (req, res) => {
  try {
    const { full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone, email_signature, skills, experiences, education, outreach_prefs } = req.body;
    const existing = await queryOne('SELECT id FROM user_profile LIMIT 1');
    if (existing) {
      await execute(
        `UPDATE user_profile SET full_name=$1, email=$2, elevator_pitch=$3, linkedin_url=$4, portfolio_url=$5,
         target_roles=$6, preferred_tone=$7, email_signature=$8, skills=$9,
         experiences=$10, education=$11, outreach_prefs=$12,
         updated_at=to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$13`,
        [full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone,
         email_signature, skills,
         JSON.stringify(experiences || []), JSON.stringify(education || []),
         JSON.stringify(outreach_prefs || {}),
         existing.id]
      );
    } else {
      await execute(
        `INSERT INTO user_profile (full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone, email_signature, skills, experiences, education, outreach_prefs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone,
         email_signature, skills,
         JSON.stringify(experiences || []), JSON.stringify(education || []),
         JSON.stringify(outreach_prefs || {})]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/profile/parse-resume — upload PDF or text, parse with Claude
router.post('/parse-resume', upload.single('resume'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    let resumeText = '';
    const isPdf = req.file.mimetype === 'application/pdf'
      || (req.file.originalname || '').toLowerCase().endsWith('.pdf');
    if (isPdf) {
      // pdf-parse v2 API: construct PDFParse, call getText() — NOT callable as a function
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: req.file.buffer });
      try {
        const result = await parser.getText();
        resumeText = (result.text || '').replace(/^-- \d+ of \d+ --$/gm, '').trim();
      } finally {
        if (parser.destroy) await parser.destroy();
      }
    } else {
      resumeText = req.file.buffer.toString('utf8');
    }

    if (!resumeText.trim()) return res.status(400).json({ error: 'Could not extract text from file' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Extract structured data from this resume. Return ONLY valid JSON — no markdown fences, no explanation, nothing else.

{
  "full_name": "string",
  "email": "string or null",
  "linkedin_url": "string or null",
  "elevator_pitch": "2-3 sentence compelling professional summary written in first person",
  "skills": "comma-separated list of technical and domain skills",
  "experiences": [
    {
      "company": "string",
      "title": "string",
      "start_date": "YYYY-MM or YYYY",
      "end_date": "YYYY-MM or YYYY or Present",
      "description": "1-2 sentence summary of key contributions"
    }
  ],
  "education": [
    {
      "school": "string",
      "degree": "string",
      "field": "string",
      "start_date": "YYYY",
      "end_date": "YYYY"
    }
  ]
}

Resume text:
${resumeText.slice(0, 8000)}`
      }]
    });

    let parsed;
    try {
      const raw = response.content[0].text.trim();
      parsed = JSON.parse(raw);
    } catch (e) {
      return res.status(500).json({ error: 'Claude returned unparseable JSON', raw: response.content[0].text });
    }

    const existing = await queryOne('SELECT id FROM user_profile LIMIT 1');
    if (existing) {
      await execute(
        `UPDATE user_profile SET full_name=$1, email=$2, linkedin_url=$3, elevator_pitch=$4, skills=$5,
         experiences=$6, education=$7, resume_raw=$8,
         updated_at=to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$9`,
        [parsed.full_name, parsed.email, parsed.linkedin_url, parsed.elevator_pitch, parsed.skills,
         JSON.stringify(parsed.experiences || []), JSON.stringify(parsed.education || []),
         resumeText.slice(0, 12000), existing.id]
      );
    } else {
      await execute(
        `INSERT INTO user_profile (full_name, email, linkedin_url, elevator_pitch, skills, experiences, education, resume_raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [parsed.full_name, parsed.email, parsed.linkedin_url, parsed.elevator_pitch, parsed.skills,
         JSON.stringify(parsed.experiences || []), JSON.stringify(parsed.education || []),
         resumeText.slice(0, 12000)]
      );
    }

    const profile = await queryOne('SELECT * FROM user_profile ORDER BY id LIMIT 1');
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/profile/duel — record one "this or that" choice into the log
router.post('/duel', async (req, res) => {
  try {
    const { category, left, right, choice } = req.body;
    if (!choice || !['left', 'right', 'skip', 'neither', 'both'].includes(choice)) {
      return res.status(400).json({ error: 'valid choice required' });
    }
    await execute(
      `INSERT INTO preference_events (category, left_json, right_json, choice)
       VALUES ($1, $2, $3, $4)`,
      [category || 'mixed', JSON.stringify(left || {}), JSON.stringify(right || {}), choice]
    );
    const c = await queryOne('SELECT COUNT(*) AS n FROM preference_events');
    res.json({ ok: true, total: parseInt(c.n) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/profile/refine — distill the choice log into a taste profile with Claude
router.post('/refine', async (req, res) => {
  try {
    const events = await query(
      `SELECT category, left_json, right_json, choice FROM preference_events ORDER BY id DESC LIMIT 80`
    );
    if (!events.length) return res.status(400).json({ error: 'No taps yet — make a few picks first.' });

    const lab = x => (x && (x.label || x.name || x.sample)) || JSON.stringify(x || {});
    const parse = v => (typeof v === 'string' ? JSON.parse(v) : v) || {};
    const lines = events.reverse().map(e => {
      const L = parse(e.left_json), R = parse(e.right_json);
      if (e.choice === 'left')    return `[${e.category}] PREFERRED "${lab(L)}" over "${lab(R)}"`;
      if (e.choice === 'right')   return `[${e.category}] PREFERRED "${lab(R)}" over "${lab(L)}"`;
      if (e.choice === 'neither') return `[${e.category}] DISLIKED BOTH "${lab(L)}" and "${lab(R)}"`;
      if (e.choice === 'both')    return `[${e.category}] LIKED BOTH "${lab(L)}" and "${lab(R)}"`;
      return `[${e.category}] skipped "${lab(L)}" vs "${lab(R)}"`;
    });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `A user is tuning their networking & outreach preferences by repeatedly choosing between two options ("this or that"). Their choice log is below (categories: style = how a message sounds, company = which leads excite them, approach = what outreach move they'd make).

Write a concise preference profile of 120–180 words that I can feed to a drafting/sourcing agent. Cover, in this order:
1. Outreach VOICE & TONE they gravitate to.
2. The kinds of COMPANIES / people that excite them (sectors, stage, vibe).
3. Outreach MOVES they're comfortable with vs. ones they avoid.
4. Any clear patterns worth noting.

Write in second person ("You prefer…"). Be specific and concrete. No preamble, no headers, just the profile prose.

CHOICE LOG (oldest first):
${lines.join('\n')}`
      }]
    });

    const taste = response.content[0].text.trim();
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const existing = await queryOne('SELECT id FROM user_profile LIMIT 1');
    if (existing) {
      await execute('UPDATE user_profile SET taste_profile=$1, taste_refined_at=$2 WHERE id=$3', [taste, ts, existing.id]);
    } else {
      await execute('INSERT INTO user_profile (taste_profile, taste_refined_at) VALUES ($1, $2)', [taste, ts]);
    }
    res.json({ taste_profile: taste, taste_refined_at: ts, count: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
