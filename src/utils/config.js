const fs = require('fs');
const path = require('path');

const DEFAULT = {
  allowed_subfolders: [
    'Rechnungen','Steuern','Bank','Versicherungen','Verträge','Medizin','Quittungen','Behörden','Sonstiges'
  ],
  allow_new_subfolders: false,
  subfolder_synonyms: {},
  routing_rules: [],
  prompt_overrides: { company_terms: [], disallowed_terms: [] }
};

function loadConfig() {
  const p = path.join(process.cwd(), 'config', 'drivesorter.config.json');
  let cfg = { ...DEFAULT };
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    cfg = { ...cfg, ...JSON.parse(raw) };
  } catch {}
  if (process.env.ALLOWED_SUBFOLDERS) {
    cfg.allowed_subfolders = process.env.ALLOWED_SUBFOLDERS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (typeof process.env.ALLOW_NEW_SUBFOLDERS !== 'undefined') {
    cfg.allow_new_subfolders = process.env.ALLOW_NEW_SUBFOLDERS === '1';
  }
  return cfg;
}

module.exports = { loadConfig };

