const express = require('express');
const router = express.Router();
const multer = require('multer');
const { queryOne, execute } = require('../db');

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
    const { full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone, email_signature, skills, experiences, education } = req.body;
    const existing = await queryOne('SELECT id FROM user_profile LIMIT 1');
    if (existing) {
      await execute(
        `UPDATE user_profile SET full_name=$1, email=$2, elevator_pitch=$3, linkedin_url=$4, portfolio_url=$5,
         target_roles=$6, preferred_tone=$7, email_signature=$8, skills=$9,
         experiences=$10, education=$11,
         updated_at=to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$12`,
        [full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone,
         email_signature, skills,
         JSON.stringify(experiences || []), JSON.stringify(education || []),
         existing.id]
      );
    } else {
      await execute(
        `INSERT INTO user_profile (full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone, email_signature, skills, experiences, education)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone,
         email_signature, skills,
         JSON.stringify(experiences || []), JSON.stringify(education || [])]
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
    if (req.file.mimetype === 'application/pdf' || req.originalUrl.endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(req.file.buffer);
      resumeText = data.text;
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

module.exports = router;
