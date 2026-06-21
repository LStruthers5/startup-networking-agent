const express = require('express');
const router = express.Router();
const multer = require('multer');
const { query, queryOne, execute } = require('../db');
const { executeAgent, trackedAnthropicClient } = require('../agent-control');
const { curateTunerFeed } = require('../intelligence-agents');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/profile
router.get('/', async (req, res) => {
  try {
    const profile = await queryOne('SELECT * FROM user_profile ORDER BY id LIMIT 1');
    const count = await queryOne('SELECT COUNT(*) AS n FROM preference_events');
    res.json({ ...(profile || {}), preference_count: parseInt(count?.n || 0) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/profile — save editable fields
router.put('/', async (req, res) => {
  try {
    const { full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone, email_signature, skills, experiences, education, outreach_prefs } = req.body;
    const existing = await queryOne('SELECT id,outreach_prefs FROM user_profile LIMIT 1');
    if (existing) {
      await execute(
        `UPDATE user_profile SET full_name=$1, email=$2, elevator_pitch=$3, linkedin_url=$4, portfolio_url=$5,
         target_roles=$6, preferred_tone=$7, email_signature=$8, skills=$9,
         experiences=$10, education=$11, outreach_prefs=$12,
         updated_at=to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$13`,
        [full_name, email, elevator_pitch, linkedin_url, portfolio_url, target_roles, preferred_tone,
         email_signature, skills,
         JSON.stringify(experiences || []), JSON.stringify(education || []),
         JSON.stringify(outreach_prefs === undefined ? (existing.outreach_prefs || {}) : outreach_prefs),
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
    await execute(
      `INSERT INTO agent_outcomes (company_id,outcome_type,notes,data_json)
       VALUES ($1,'tuner_preference',$2,$3)`,
      [
        selected.find(item => item?.company_id)?.company_id || null,
        `${category || 'mixed'}: ${choice}`,
        JSON.stringify({ category, choice, selected, rejected }),
      ]
    );
    const companyScores = [];
    if (category === 'company') {
      const scoreChanges = new Map();
      for (const item of selected) {
        if (item?.company_id) scoreChanges.set(Number(item.company_id), 1);
      }
      for (const item of rejected) {
        if (item?.company_id) scoreChanges.set(Number(item.company_id), -1);
      }
      for (const [companyId, delta] of scoreChanges) {
        const row = await queryOne(
          `UPDATE companies
           SET score=GREATEST(1, LEAST(5, COALESCE(score,3) + $1))
           WHERE id=$2
           RETURNING id,score`,
          [delta, companyId]
        );
        if (row) companyScores.push(row);
      }
    }
    const c = await queryOne('SELECT COUNT(*) AS n FROM preference_events');
    const profile = await queryOne('SELECT taste_refined_at FROM user_profile ORDER BY id LIMIT 1');
    const unrefined = await queryOne(
      `SELECT COUNT(*) AS n FROM preference_events
       WHERE $1::text IS NULL OR created_at > $1`,
      [profile?.taste_refined_at || null]
    );
    res.json({
      ok: true,
      total: parseInt(c.n),
      company_scores: companyScores,
      refine_recommended: Number(unrefined?.n || 0) >= 12,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/profile/tuner-feed — agent-derived cards awaiting human judgment
router.get('/tuner-feed', async (req, res) => {
  try {
    res.json(await curateTunerFeed(30));
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

    const refined = await executeAgent('profile-refiner', {
      trigger: 'manual',
      input: { event_count: events.length, choices: lines },
    }, async () => {
      const client = trackedAnthropicClient();
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1400,
        messages: [{
          role: 'user',
          content: `A user is continuously tuning an automated networking intelligence system through quick preference comparisons.
The log may contain preferences about companies, investors, events, relationship paths, research allocation, signal quality, outreach tone, asks, channels, and timing.

Distill the evidence into an agent-ready preference model. Do not overstate a pattern supported by only one choice. Repeated choices should carry more weight. Preserve uncertainty and contradictions.

Return ONLY valid JSON:
{
  "summary": "A concise 160–240 word second-person profile suitable for all sourcing, ranking, research, event, investor, relationship, and outreach agents.",
  "company_preferences": {
    "sectors": [], "stages": [], "missions": [], "operating_traits": [],
    "positive_signals": [], "negative_signals": []
  },
  "investor_preferences": {
    "roles": [], "firm_traits": [], "sector_focus": [], "stage_focus": [],
    "relationship_preferences": []
  },
  "event_preferences": {
    "formats": [], "topics": [], "locations": [], "hosts": [], "avoid": []
  },
  "research_preferences": {
    "priority_factors": [], "exploration_level": "low|balanced|high",
    "evidence_threshold": "low|balanced|high", "timing_preferences": []
  },
  "outreach_preferences": {
    "tone": [], "channels": [], "asks": [], "moves": [], "avoid": []
  },
  "confidence": {
    "overall": 0.0,
    "well_established": [],
    "still_uncertain": [],
    "contradictions": []
  }
}

CHOICE LOG (oldest first):
${lines.join('\n')}`
        }]
      });
      const raw = response.content[0].text.trim();
      const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || '{}';
      return JSON.parse(jsonText);
    });
    const taste = refined.summary || '';
    if (!taste) throw new Error('The preference refiner returned no usable summary.');
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const existing = await queryOne('SELECT id FROM user_profile LIMIT 1');
    if (existing) {
      await execute(
        'UPDATE user_profile SET taste_profile=$1,outreach_prefs=$2,taste_refined_at=$3 WHERE id=$4',
        [taste, JSON.stringify(refined), ts, existing.id]
      );
    } else {
      await execute(
        'INSERT INTO user_profile (taste_profile,outreach_prefs,taste_refined_at) VALUES ($1,$2,$3)',
        [taste, JSON.stringify(refined), ts]
      );
    }
    const adaptiveAgents = [
      'daily-candidate-ranking',
      'queue-suggestions',
      'company-discovery',
      'company-profile-curator',
      'opportunity-investigator',
      'relationship-pathfinder',
      'event-discovery',
      'follow-up-strategist',
      'outreach-draft',
    ];
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
        preference_model: refined,
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
          JSON.stringify({
            taste_profile: { from: currentConfig.taste_profile || null, to: taste },
            preference_dimensions: Object.keys(refined).filter(key => key !== 'summary'),
          }),
          JSON.stringify([{ source: 'outreach-tuner', event_count: events.length, refined_at: ts }]),
          agentKey === 'queue-suggestions' ? 0.08 : 0.03,
          'Prioritize searches and recommendations that better match accepted Tuner signals.',
          'accepted actionable opportunities',
        ]
      );
    }
    res.json({ taste_profile: taste, preference_model: refined, taste_refined_at: ts, count: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
