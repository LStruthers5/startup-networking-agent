const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSignals } = require('../signal-normalizer');
const { extractDustPayload, extractDustText, dustPayloadToSignals } = require('../dust-response');

test('normalizes opportunity cards into actionable company signals', () => {
  const signals = normalizeSignals('queue-suggestions', [{
    company_id: 42,
    company_name: 'Lumen Health',
    timing: 'Hiring momentum makes this a useful week to reach out.',
    warm: { name: 'Jane', firm: 'Seed Fund' },
  }], {}, null);

  assert.equal(signals.length, 1);
  assert.equal(signals[0].signal_type, 'company');
  assert.equal(signals[0].company_id, 42);
  assert.equal(signals[0].actionable, 1);
});

test('preserves source URLs and confidence for event findings', () => {
  const signals = normalizeSignals('event-discovery', [{
    title: 'AI Health Founder Night',
    event_url: 'https://lu.ma/example',
    confidence: 0.9,
  }], {}, null);

  assert.equal(signals[0].signal_type, 'event');
  assert.equal(signals[0].source_url, 'https://lu.ma/example');
});

test('turns narrative agent output into a recommendation signal', () => {
  const signals = normalizeSignals(
    'weekly-recap',
    'Next action: prioritize two warm introductions this week.',
    { name: 'Weekly plan' },
    null
  );

  assert.equal(signals.length, 1);
  assert.equal(signals[0].signal_type, 'recommendation');
  assert.equal(signals[0].actionable, 1);
});

test('preserves structured signal metadata from intelligence agents', () => {
  const signals = normalizeSignals('company-signal-monitor', [{
    company_id: 9,
    title: 'Acme launches a new product',
    summary: 'A verified launch creates a timely conversation angle.',
    signal_type: 'product',
    source_url: 'https://acme.example/news',
    observed_at: '2026-06-20',
    confidence: 0.91,
    actionable: true,
  }], {}, null);

  assert.equal(signals[0].signal_type, 'product');
  assert.equal(signals[0].company_id, 9);
  assert.equal(signals[0].source_url, 'https://acme.example/news');
  assert.equal(signals[0].actionable, 1);
  assert.equal(signals[0].observed_at, '2026-06-20');
});

test('extracts structured investigation JSON from a nested Dust conversation', () => {
  const response = {
    conversation: {
      messages: [{
        type: 'agent_message',
        content: [{
          type: 'text',
          text: JSON.stringify({
            company: { name: 'Acme', summary: 'A focused medical-device company.' },
            investigation: { status: 'promote', confidence: 0.88, overall_assessment: 'Strong fit with timely momentum.' },
            verified_signals: [{
              signal_type: 'product',
              title: 'Acme launched a new device',
              summary: 'The launch expands its clinical product line.',
              source_url: 'https://acme.example/launch',
              confidence: 0.9,
              new_information: true,
            }],
            recommended_next_step: { action: 'prepare_outreach_for_approval' },
          }),
        }],
      }],
    },
  };
  const payload = extractDustPayload(response);
  const signals = dustPayloadToSignals(payload, { id: 3, name: 'Acme' });
  assert.equal(payload.investigation.status, 'promote');
  assert.equal(signals[0].summary, 'Strong fit with timely momentum.');
  assert.equal(signals[1].source_url, 'https://acme.example/launch');
  assert.match(extractDustText(response), /verified_signals/);
});

test('stringifies object summaries instead of rendering object Object', () => {
  const signals = normalizeSignals('example', {
    title: 'Structured result',
    summary: { status: 'promote', reason: 'Strong fit' },
  }, {}, null);
  assert.match(signals[0].summary, /Strong fit/);
  assert.doesNotMatch(signals[0].summary, /object Object/);
});
