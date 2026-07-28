const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { query, queryOne, execute } = require('../db');

const upload = multer({ storage: multer.memoryStorage() });

router.get('/', async (req, res) => {
  res.json(await query('SELECT * FROM contacts ORDER BY firm, name'));
});

// POST /api/contacts/import — LinkedIn "Connections.csv" from the official data export
// (Settings → Data Privacy → Get a copy of your data → Connections). LinkedIn prepends a few
// "Notes:" preamble lines before the real header, so we find the header row first, then parse.
// Upserts by profile URL (falls back to name) so re-importing an updated export backfills emails
// rather than duplicating. These become warm-intro candidates for outreach.
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const raw = req.file.buffer.toString('utf8');
  const lines = raw.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => /^"?First Name"?,/.test(l));
  if (headerIdx === -1) {
    return res.status(400).json({ error: 'This does not look like a LinkedIn Connections export (no "First Name" header found).' });
  }

  let records;
  try {
    records = parse(lines.slice(headerIdx).join('\n'), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (err) {
    return res.status(400).json({ error: 'CSV parse error: ' + err.message });
  }

  let added = 0, updated = 0, skipped = 0, withEmail = 0;
  for (const row of records) {
    const name = [row['First Name'], row['Last Name']].filter(Boolean).join(' ').trim();
    if (!name) { skipped++; continue; }
    const email = (row['Email Address'] || '').trim();
    const url = (row['URL'] || '').trim();
    const firm = (row['Company'] || '').trim();
    const role = (row['Position'] || '').trim();
    const connectedOn = (row['Connected On'] || '').trim();
    if (email) withEmail++;

    // Match on profile URL first (stable), else exact name.
    const existing = url
      ? await queryOne('SELECT id FROM contacts WHERE linkedin_url = $1 LIMIT 1', [url])
      : await queryOne('SELECT id FROM contacts WHERE LOWER(name) = LOWER($1) AND source = $2 LIMIT 1', [name, 'linkedin']);

    if (existing) {
      // Backfill only empty fields so any manual edits or a later-shared email are preserved/added.
      await execute(
        `UPDATE contacts SET
           email = COALESCE(NULLIF(email,''), $1),
           firm = COALESCE(NULLIF(firm,''), $2),
           role = COALESCE(NULLIF(role,''), $3),
           connected_on = COALESCE(NULLIF(connected_on,''), $4)
         WHERE id = $5`,
        [email, firm, role, connectedOn, existing.id]
      );
      updated++;
    } else {
      await execute(
        `INSERT INTO contacts (name, firm, role, email, linkedin_url, connected_on, how_i_know_them, source)
         VALUES ($1,$2,$3,$4,$5,$6,'LinkedIn connection','linkedin')`,
        [name, firm, role, email, url, connectedOn]
      );
      added++;
    }
  }

  res.json({ added, updated, skipped, withEmail, total: records.length });
});

router.post('/', async (req, res) => {
  const { name, firm, role, email, linkedin_url, sector_focus, stage_focus, how_i_know_them, notes } = req.body;
  const result = await execute(
    `INSERT INTO contacts (name, firm, role, email, linkedin_url, sector_focus, stage_focus, how_i_know_them, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [name||'', firm||'', role||'', email||'', linkedin_url||'', sector_focus||'', stage_focus||'', how_i_know_them||'', notes||'']
  );
  res.json({ id: result.lastInsertRowid });
});

router.patch('/:id', async (req, res) => {
  const allowed = ['name', 'firm', 'role', 'email', 'linkedin_url', 'sector_focus', 'stage_focus', 'how_i_know_them', 'notes'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const vals = [...fields.map(f => req.body[f]), req.params.id];
  await execute(`UPDATE contacts SET ${sets} WHERE id = $${fields.length + 1}`, vals);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await execute('DELETE FROM contacts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
