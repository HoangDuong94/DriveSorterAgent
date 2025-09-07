const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSubfolder } = require('../src/utils/subfolder');

const cfgFixed = {
  allowed_subfolders: ["Rechnungen","Steuern","Bank","Versicherungen","Verträge","Medizin","Quittungen","Behörden","Sonstiges"],
  allow_new_subfolders: false,
  subfolder_synonyms: { "steuerbescheid": "Steuern", "arzt": "Medizin" }
};

const cfgOpen = { ...cfgFixed, allow_new_subfolders: true };

test('maps synonyms to canonical', () => {
  assert.equal(normalizeSubfolder('Steuerbescheid 2024', cfgFixed), 'Steuern');
  assert.equal(normalizeSubfolder('Arzt Unterlagen', cfgFixed), 'Medizin');
});

test('falls back to best allowed when new folders are disallowed', () => {
  // heuristic should lean to Rechnungen for energy-related naming
  assert.equal(normalizeSubfolder('Energieabrechnung', cfgFixed), 'Rechnungen');
});

test('allows new folder when enabled', () => {
  assert.equal(normalizeSubfolder('CustomX', cfgOpen), 'CustomX');
});

