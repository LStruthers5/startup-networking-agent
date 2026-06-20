const express = require('express');
const router = express.Router();
const multer = require('multer');
const { query, queryOne, execute } = require('../db');
const { executeAgent, trackedAnthropicClient } = require('../agent-control');

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

    const parsed = await executeAgent('resume-parser', {
      trigger: 'manual',
      input: { filename: req.file.originalname, text_length: resumeText.length },
    }, async () => {
      const client = trackedAnthropicClient();
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
      try {
        return JSON.parse(response.content[0].text.trim());
      } catch (_) {
        throw new Error('Claude returned unparseable resume JSON');
      }
    });

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
    const selected = choice === 'left' ? [left] : choice === 'right' ? [right] : choice === 'both' ? [left, right] : [];
    const rejected = choice === 'left' ? [right] : choice === 'right' ? [left] : choice === 'neither' ? [left, right] : [];
    for (const item of selected) {
      if (!item?.signal_id) continue;
      const signal = await queryOne('SELECT run_id, accepted FROM agent_signals WHERE id=$1', [item.signal_id]);
      await execute(`UPDATE agent_signals SET status='accepted',accepted=1 WHERE id=$1`, [item.signal_id]);
      if (signal?.run_id && !signal.accepted) {
        await execute('UPDATE agent_runs SET accepted_count=COALESCE(accepted_count,0)+1 WHERE id=$1', [signal.run_id]);
        await execute(
          `INSERT INTO agent_outcomes (run_id,signal_id,company_id,outcome_type,notes,data_json)
           SELECT $1,$2,company_id,'tuner_selected','Selected in Outreach Tuner',$3
           FROM agent_signals WHERE id=$2`,
          [signal.run_id, item.signal_id, JSON.stringify({ category, choice })]
        );
      }
    }
    for (const item of rejected) {
      if (item?.signal_id) await execute(`UPDATE agent_signals SET status='rejected' WHERE id=$1`, [item.signal_id]);
    }
    const c = await queryOne('SELECT COUNT(*) AS n FROM preference_events');
    res.json({ ok: true, total: parseInt(c.n) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/profile/tuner-feed — agent-derived cards awaiting human judgment
router.get('/tuner-feed', async (req, res) => {
  try {
    const rows = await query(`
      SELECT s.id, s.signal_type, s.title, s.summary, s.confidence, s.source_name,
        s.company_id, c.name AS company_name, c.sector, c.stage
      FROM agent_signals s
      LEFT JOIN companies c ON c.id=s.company_id
      WHERE s.status='new' AND s.duplicate_of_id IS NULL
      ORDER BY s.actionable DESC, s.confidence DESC, s.created_at DESC
      LIMIT 30
    `);
    res.json(rows.map(row => ({
      id: row.id,
      label: row.company_name || row.title,
      name: row.company_name || row.title,
      sample: [
        [row.sector, row.stage].filter(Boolean).join(' · '),
        row.summary,
        row.source_name ? `From ${row.source_name}` : '',
      ].filter(Boolean).join('\n'),
      tags: [row.signal_type, row.sector, row.stage].filter(Boolean),
      signal_id: row.id,
      company_id: row.company_id,
      confidence: Number(row.confidence || 0),
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    const taste = await executeAgent('profile-refiner', {
      trigger: 'manual',
      input: { event_count: events.length, choices: lines },
    }, async () => {
      const client = trackedAnthropicClient();
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
      return response.content[0].text.trim();
    });
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const existing = await queryOne('SELECT id FROM user_profile LIMIT 1');
    if (existing) {
      await execute('UPDATE user_profile SET taste_profile=$1, taste_refined_at=$2 WHERE id=$3', [taste, ts, existing.id]);
    } else {
      await execute('INSERT INTO user_profile (taste_profile, taste_refined_at) VALUES ($1, $2)', [taste, ts]);
    }
    const adaptiveAgents = ['daily-candidate-ranking', 'queue-suggestions'];
    for (const agentKey of adaptiveAgents) {
      const agent = await queryOne('SELECT current_version,config_json FROM agent_registry WHERE agent_key=$1', [agentKey]);
      const pending = await queryOne(
        `SELECT id FROM adaptation_proposals WHERE agent_key=$1 AND status='pending' ORDER BY id DESC LIMIT 1`,
        [agentKey]
      );
      if (!agent || pending) continue;
      const currentConfig = typeof agent.config_json === 'string' ? JSON.parse(agent.config_json || '{}') : (agent.config_json || {});
      const proposedConfig = {
        ...currentConfig,
        taste_profile: taste,
        adaptation_mode: 'taste-guided',
        evidence_event_count: events.length,
        proposed_at: ts,
      };
      await execute(
        `INSERT INTO adaptation_proposals
         (agent_key,proposal_type,current_version,proposed_config,diff_json,evidence_json,
          estimated_daily_cost_delta,expected_impact,trial_days,success_metric)
         VALUES ($1,'taste-adaptation',$2,$3,$4,$5,$6,$7,7,$8)`,
        [
          agentKey, agent.current_version,
          JSON.stringify(proposedConfig),
          JSON.stringify({ taste_profile: { from: currentConfig.taste_profile || null, to: taste } }),
          JSON.stringify([{ source: 'outreach-tuner', event_count: events.length, refined_at: ts }]),
          agentKey === 'queue-suggestions' ? 0.08 : 0.03,
          'Prioritize searches and recommendations that better match accepted Tuner signals.',
          'accepted actionable opportunities',
        ]
      );
    }
    res.json({ taste_profile: taste, taste_refined_at: ts, count: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
