const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSignals } = require('../signal-normalizer');

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
