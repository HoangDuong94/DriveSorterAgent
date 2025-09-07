const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMetadataFromText, buildFilename, classifyCategory } = require('../src/utils/pdfNaming');

test('extracts metadata and builds filename for a typical invoice', () => {
  const sample = `
  ACME GmbH
  Musterstraße 1, 12345 Musterstadt
  
  Rechnung
  Rechnungsnummer: 12345
  Datum: 15.08.2024
  Betrag: 199,00 EUR
  `;

  const meta = extractMetadataFromText(sample);
  assert.equal(meta.invoiceNumber, '12345');
  assert.equal(meta.dateISO, '2024-08-15');
  assert.ok(/acme gmbh/i.test(meta.sender), 'sender should contain ACME GmbH');
  assert.equal(meta.category, 'Rechnungen');

  const filename = buildFilename('input.pdf', meta);
  assert.match(filename, /rechnung/);
  assert.match(filename, /acme-gmbh/);
  assert.match(filename, /2024-08-15/);
  assert.match(filename, /12345/);
  assert.match(filename, /\.pdf$/);
});

test('classifies categories by keywords', () => {
  assert.equal(classifyCategory('Versicherung Police 9988'), 'Versicherungen');
  assert.equal(classifyCategory('Kontoauszug Bank'), 'Bank');
  assert.equal(classifyCategory('Vertrag Kündigung'), 'Verträge');
  assert.equal(classifyCategory('Finanzamt Steuerbescheid'), 'Steuern');
  assert.equal(classifyCategory('Quittung Kassenbon'), 'Quittungen');
  assert.equal(classifyCategory('Arztpraxis Befund'), 'Medizin');
});

