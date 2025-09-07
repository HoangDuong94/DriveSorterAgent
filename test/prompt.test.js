const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt } = require('../src/utils/prompt');

test('buildPrompt injects guardrails and allowed list', () => {
  const base = 'BASE PROMPT';
  const out = buildPrompt(base, {
    allowedSubfolders: ['Rechnungen','Steuern'],
    allowNewSubfolders: false,
    knownInstitutions: ['Suva'],
    disallowedTerms: ['Minh Hoang Duong']
  });
  assert.match(out, /BASE PROMPT/);
  assert.match(out, /Allowed subfolders/);
  assert.match(out, /- Rechnungen/);
  assert.match(out, /allow_new_subfolders = false/);
  assert.match(out, /Known institutions: Suva/);
  assert.match(out, /Do not include these names in filenames: Minh Hoang Duong/);
});

