// Tower as a Claude connector. Mounts a stateless Streamable-HTTP MCP endpoint at /mcp/:token so
// any Claude surface (desktop, mobile, Claude Code) can talk to the Tower directly — "here are my
// notes from the event, add them to my river" — the same way the user already talks to gcal.
// Token-in-path is the auth (same pattern as the draft approve/skip links); set MCP_TOKEN in env.
const crypto = require('crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { query, queryOne, execute, nowText } = require('./db');
const { executeAgent, trackedAnthropicClient } = require('./agent-control');
const { buildRunners, COMPANY_SCOPED } = require('./agent-runners');

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const errText = s => ({ content: [{ type: 'text', text: s }], isError: true });

function tokenMatches(candidate) {
  const expected = process.env.MCP_TOKEN || '';
  if (!expected || !candidate || candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

// ─── ingest_notes internals ───────────────────────────────────────────────────

async function parseNotes(rawText) {
  const client = trackedAnthropicClient();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1600,
    messages: [{
      role: 'user',
      content: `Parse these free-form networking notes into structured records. Extract ONLY what is actually
stated — never invent names, firms, or details that aren't there. People the user met or talked to go in
"people". Companies discussed as potential pipeline targets go in "companies". Scheduled or attended
gatherings go in "events". Anything else worth remembering (intros promised, follow-ups owed, market
observations) goes in "observations".

Return ONLY valid JSON:
{
  "people": [{"name":"","firm":"","role":"","relationship_status":"met|warm|cold","context":"how they met / what was discussed"}],
  "companies": [{"name":"","website":"","sector":"","stage":"","description":"","why_interesting":""}],
  "events": [{"title":"","event_date":"YYYY-MM-DD or empty","location":"","notes":""}],
  "observations": [{"title":"","detail":""}],
  "summary": "one sentence describing what these notes contained"
}

NOTES:
${rawText}`,
    }],
  });
  const raw = response.content[0].text.trim();
  return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
}

async function ingestParsed(parsed) {
  const changes = [];
  const signals = [];

  for (const person of parsed.people || []) {
    if (!person.name) continue;
    const existing = await queryOne('SELECT id, relationship_status, notes FROM investors WHERE LOWER(name)=LOWER($1) LIMIT 1', [person.name]);
    if (existing) {
      // Never downgrade an established relationship; append context instead of overwriting notes.
      await execute(
        `UPDATE investors SET
           relationship_status = CASE WHEN relationship_status IN ('cold','outreach_sent') THEN $1 ELSE relationship_status END,
           notes = CASE WHEN COALESCE(notes,'')='' THEN $2 ELSE notes || E'\n' || $2 END,
           last_touched = $3
         WHERE id = $4`,
        [person.relationship_status || 'met', `[notes ${nowText().slice(0, 10)}] ${person.context || ''}`, nowText(), existing.id]
      );
      changes.push(`Updated ${person.name} (relationship, notes)`);
    } else {
      await execute(
        `INSERT INTO investors (name, firm, role, relationship_status, how_i_know_them, notes, source, confirmed, last_touched)
         VALUES ($1,$2,$3,$4,$5,'','mcp',1,$6)`,
        [person.name, person.firm || '', person.role || '', person.relationship_status || 'met', person.context || '', nowText()]
      );
      changes.push(`Added ${person.name}${person.firm ? ` (${person.firm})` : ''}`);
    }
    signals.push({
      title: `Met/updated: ${person.name}${person.firm ? ` — ${person.firm}` : ''}`,
      summary: person.context || 'Captured from your notes.',
      signal_type: 'person', entity_type: 'investor', confidence: 1, actionable: true,
      data: person,
    });
  }

  for (const company of parsed.companies || []) {
    if (!company.name) continue;
    const existing = await queryOne('SELECT id FROM companies WHERE LOWER(name)=LOWER($1) LIMIT 1', [company.name]);
    if (existing) {
      changes.push(`${company.name} already in pipeline (left unchanged)`);
    } else {
      await execute(
        `INSERT INTO companies (name, website, sector, stage, description, source, notes)
         VALUES ($1,$2,$3,$4,$5,'mcp',$6)`,
        [company.name, company.website || '', company.sector || '', company.stage || '', company.description || '', company.why_interesting || '']
      );
      changes.push(`Added company ${company.name}`);
    }
    signals.push({
      title: `From your notes: ${company.name}`,
      summary: `${company.description || ''}${company.why_interesting ? ` Why: ${company.why_interesting}` : ''}`.trim() || 'Mentioned in your notes.',
      signal_type: 'company', entity_type: 'company', confidence: 1, actionable: true,
      data: company,
    });
  }

  for (const event of parsed.events || []) {
    if (!event.title) continue;
    await execute(
      `INSERT INTO events (title, event_date, location, description, source) VALUES ($1,$2,$3,$4,'notes')`,
      [event.title, event.event_date || null, event.location || '', event.notes || '']
    );
    changes.push(`Logged event: ${event.title}`);
    signals.push({
      title: `Event: ${event.title}`,
      summary: `${event.event_date || ''}${event.location ? ` — ${event.location}` : ''}. ${event.notes || ''}`.trim(),
      signal_type: 'event', entity_type: 'event', confidence: 1, actionable: false,
      data: event,
    });
  }

  for (const obs of parsed.observations || []) {
    if (!obs.title) continue;
    signals.push({
      title: obs.title,
      summary: obs.detail || '',
      signal_type: 'claim', entity_type: '', confidence: 1, actionable: true,
      data: obs,
    });
    changes.push(`Noted: ${obs.title}`);
  }

  return { changes, signals };
}

// ─── Server & tools ───────────────────────────────────────────────────────────

function buildServer() {
  const server = new McpServer({ name: 'networking-tower', version: '1.0.0' });

  server.registerTool('ingest_notes', {
    title: 'Ingest networking notes',
    description: 'Send free-form notes (event recaps, "met X from Y", company mentions, follow-ups owed) and the Tower parses them into contacts, companies, events, and river signals. Returns a summary of everything created or updated.',
    inputSchema: { notes: z.string().describe('The raw notes, any format') },
  }, async ({ notes }) => {
    if (!notes?.trim()) return errText('Empty notes.');
    let result;
    const output = await executeAgent('mcp-ingest', {
      trigger: 'manual',
      input: { note_length: notes.length },
    }, async () => {
      const parsed = await parseNotes(notes);
      result = await ingestParsed(parsed);
      result.summary = parsed.summary || '';
      return result.signals;
    });
    return text(`Done — ${result.summary}\n\n${result.changes.map(c => `• ${c}`).join('\n') || 'Nothing extractable found.'}\n\n${output.length} signal(s) added to the river.`);
  });

  server.registerTool('query_pipeline', {
    title: 'Search companies & investors',
    description: 'Search the pipeline by name, firm, sector, or status. Returns matching companies and investors.',
    inputSchema: { search: z.string().describe('Name, firm, sector, or status text to match') },
  }, async ({ search }) => {
    const like = `%${search}%`;
    const [companies, investors] = await Promise.all([
      query(`SELECT id,name,sector,stage,status,score,momentum_score,last_funding FROM companies
             WHERE name ILIKE $1 OR sector ILIKE $1 OR status ILIKE $1 ORDER BY score DESC NULLS LAST LIMIT 15`, [like]),
      query(`SELECT id,name,firm,role,relationship_status,tier FROM investors
             WHERE name ILIKE $1 OR firm ILIKE $1 ORDER BY tier ASC LIMIT 15`, [like]),
    ]);
    return text({ companies, investors });
  });

  server.registerTool('query_river', {
    title: 'Recent river signals',
    description: 'The latest intelligence signals across all agents — what the system has found recently.',
    inputSchema: { limit: z.number().optional().describe('Max signals to return (default 15)') },
  }, async ({ limit }) => {
    const rows = await query(
      `SELECT s.created_at, s.signal_type, s.title, s.summary, s.confidence, c.name AS company_name, s.agent_key
       FROM agent_signals s LEFT JOIN companies c ON c.id=s.company_id
       WHERE s.status NOT IN ('duplicate','rejected')
       ORDER BY s.created_at DESC LIMIT $1`,
      [Math.min(50, Number(limit) || 15)]
    );
    return text(rows);
  });

  server.registerTool('update_company', {
    title: 'Update a company',
    description: 'Update a pipeline company\'s status (new/researching/outreach/passed/archived), score (1-5), or append a note.',
    inputSchema: {
      name: z.string().describe('Company name (matched case-insensitively)'),
      status: z.string().optional(),
      score: z.number().optional(),
      note: z.string().optional(),
    },
  }, async ({ name, status, score, note }) => {
    const company = await queryOne('SELECT id,name,notes FROM companies WHERE LOWER(name)=LOWER($1) LIMIT 1', [name]);
    if (!company) return errText(`No company named "${name}" in the pipeline.`);
    const sets = [], vals = [];
    if (status) { sets.push(`status=$${vals.length + 1}`); vals.push(status); }
    if (score != null) { sets.push(`score=$${vals.length + 1}`); vals.push(Math.max(1, Math.min(5, Number(score)))); }
    if (note) { sets.push(`notes=CASE WHEN COALESCE(notes,'')='' THEN $${vals.length + 1} ELSE notes || E'\n' || $${vals.length + 1} END`); vals.push(note); }
    if (!sets.length) return errText('Nothing to update — pass status, score, or note.');
    sets.push(`last_touched=$${vals.length + 1}`); vals.push(nowText());
    vals.push(company.id);
    await execute(`UPDATE companies SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    return text(`Updated ${company.name}.`);
  });

  server.registerTool('log_interaction', {
    title: 'Log an interaction with a person',
    description: 'Record that you talked to / met / heard back from someone. Updates (or creates) the investor record and bumps the relationship.',
    inputSchema: {
      person: z.string().describe('Their name'),
      note: z.string().describe('What happened'),
      relationship_status: z.string().optional().describe('cold | met | warm | outreach_sent (default: met)'),
      firm: z.string().optional(),
    },
  }, async ({ person, note, relationship_status, firm }) => {
    const status = ['cold', 'met', 'warm', 'outreach_sent'].includes(relationship_status) ? relationship_status : 'met';
    const existing = await queryOne('SELECT id FROM investors WHERE LOWER(name)=LOWER($1) LIMIT 1', [person]);
    if (existing) {
      await execute(
        `UPDATE investors SET relationship_status=$1, last_touched=$2,
         notes=CASE WHEN COALESCE(notes,'')='' THEN $3 ELSE notes || E'\n' || $3 END WHERE id=$4`,
        [status, nowText(), `[${nowText().slice(0, 10)}] ${note}`, existing.id]
      );
      return text(`Logged — ${person} is now "${status}".`);
    }
    await execute(
      `INSERT INTO investors (name, firm, relationship_status, how_i_know_them, source, confirmed, last_touched)
       VALUES ($1,$2,$3,$4,'mcp',1,$5)`,
      [person, firm || '', status, note, nowText()]
    );
    return text(`Added ${person}${firm ? ` (${firm})` : ''} as "${status}".`);
  });

  server.registerTool('list_drafts', {
    title: 'List outreach drafts',
    description: 'List outreach drafts by status: pending (default), sent, skipped, approved_manual.',
    inputSchema: { status: z.string().optional() },
  }, async ({ status }) => {
    const rows = await query(
      `SELECT d.id, d.investor_name, d.investor_email, d.channel, d.subject, d.status, d.stakes_tier,
              d.scheduled_send_at, d.replied_at, d.created_at, c.name AS company_name
       FROM drafts d LEFT JOIN companies c ON c.id=d.company_id
       WHERE d.status=$1 ORDER BY d.created_at DESC LIMIT 25`,
      [status || 'pending']
    );
    return text(rows);
  });

  server.registerTool('approve_draft', {
    title: 'Approve & send a draft',
    description: 'SENDS A REAL EMAIL to the investor if an email address is on file. Only call this when the user has explicitly named which draft to approve. For InMail drafts with no email, it marks the draft handled and returns the text + LinkedIn URL for manual sending.',
    inputSchema: { draft_id: z.number().describe('The draft id (from list_drafts)') },
  }, async ({ draft_id }) => {
    const draft = await queryOne(
      `SELECT d.*, c.name AS company_name FROM drafts d LEFT JOIN companies c ON c.id=d.company_id WHERE d.id=$1`,
      [draft_id]
    );
    if (!draft) return errText(`No draft with id ${draft_id}.`);
    if (draft.status !== 'pending') return errText(`Draft ${draft_id} is already ${draft.status}.`);
    if (!draft.investor_email) {
      await execute(`UPDATE drafts SET status='approved_manual' WHERE id=$1`, [draft.id]);
      const linkedin = draft.linkedin_url || `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(draft.investor_name || '')}`;
      return text(`No email on file — marked handled for manual send.\n\nSend this on LinkedIn (${linkedin}):\n\n${draft.body}`);
    }
    const { sendDraftEmail } = require('./email');
    await sendDraftEmail(draft);
    return text(`Sent to ${draft.investor_name} (${draft.investor_email}) — subject: "${draft.subject}".`);
  });

  server.registerTool('skip_draft', {
    title: 'Skip a draft',
    description: 'Mark a pending draft as skipped (won\'t send, won\'t show again).',
    inputSchema: { draft_id: z.number() },
  }, async ({ draft_id }) => {
    const draft = await queryOne('SELECT id, investor_name, status FROM drafts WHERE id=$1', [draft_id]);
    if (!draft) return errText(`No draft with id ${draft_id}.`);
    if (draft.status !== 'pending') return errText(`Draft ${draft_id} is already ${draft.status}.`);
    await execute(`UPDATE drafts SET status='skipped' WHERE id=$1`, [draft_id]);
    return text(`Skipped the draft for ${draft.investor_name}.`);
  });

  server.registerTool('run_agent', {
    title: 'Run an intelligence agent now',
    description: `Trigger one of the Tower's agents immediately. Available: ${Object.keys(buildRunners()).join(', ')}. ${COMPANY_SCOPED.join(' and ')} require company_id.`,
    inputSchema: {
      agent_key: z.string(),
      limit: z.number().optional(),
      company_id: z.number().optional(),
      days: z.number().optional(),
    },
  }, async ({ agent_key, limit, company_id, days }) => {
    const runners = buildRunners({ limit, company_id, days });
    const runner = runners[agent_key];
    if (!runner) return errText(`Unknown agent "${agent_key}". Available: ${Object.keys(runners).join(', ')}`);
    if (COMPANY_SCOPED.includes(agent_key) && !company_id) return errText(`${agent_key} requires company_id.`);
    const output = await runner();
    const count = Array.isArray(output) ? output.length : 1;
    return text(`${agent_key} completed — ${count} result(s).\n${JSON.stringify(output, null, 2).slice(0, 3000)}`);
  });

  server.registerTool('trigger_morning_brief', {
    title: 'Send the morning briefing now',
    description: 'Generates fresh drafts and sends the morning briefing email immediately (same as the daily 8am job).',
    inputSchema: {},
  }, async () => {
    const result = await require('./scheduler').runDailyJob();
    return text(`Morning briefing sent — ${result.autoDrafts} new draft(s), ${result.pendingDrafts} pending total, ${result.events} event(s).`);
  });

  return server;
}

// Stateless mount: a fresh server+transport per request, torn down when the response closes.
function mountMcp(app) {
  app.post('/mcp/:token', async (req, res) => {
    if (!process.env.MCP_TOKEN) return res.status(503).json({ error: 'MCP not configured — set MCP_TOKEN.' });
    if (!tokenMatches(req.params.token)) return res.status(401).json({ error: 'Bad token' });
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] Request failed:', error.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal MCP error' });
    }
  });
  // Stateless server: no SSE stream to resume, no session to delete.
  app.get('/mcp/:token', (req, res) => res.status(405).json({ error: 'Stateless server — POST only' }));
  app.delete('/mcp/:token', (req, res) => res.status(405).json({ error: 'Stateless server — POST only' }));
}

module.exports = { mountMcp };
