function norm(s){ return String(s||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,''); }

function bestAllowed(name, allowed) {
  const n = norm(name);
  let best = 'Sonstiges', bestScore = -1;
  for (const a of allowed) {
    const an = norm(a);
    const tokens = n.split(/[^a-z0-9]+/).filter(Boolean);
    const common = tokens.filter(t => an.includes(t)).length;
    const score = common * 10 - Math.abs(an.length - n.length);
    if (score > bestScore) { best = a; bestScore = score; }
  }
  return best;
}

function normalizeSubfolder(input, cfg) {
  if (!input) return 'Sonstiges';
  const n = norm(input);
  // Heuristic keyword mapping
  // Payroll documents
  if (/(lohnabrechnung|gehaltsabrechnung|payslip|pay\s*slip|wage\s*slip|salary\s*slip|payroll)/i.test(input)) return 'Lohnabrechnungen';
  if (/(lohnausweis|lohnausweise|wage\s*statement|salary\s*statement|income\s*statement)/i.test(input)) return 'Lohnausweise';
  // Generic invoices after payroll-specific mapping
  if (/(rechnung|abrechnung|invoice|zahlung|mwst|\bbetrag\b)/i.test(input)) return 'Rechnungen';
  if (/(versicherung|police|schadennummer)/i.test(input)) return 'Versicherungen';
  if (/(kontoauszug|bank|ueberweisung|überweisung|sepa|lastschrift)/i.test(input)) return 'Bank';
  if (/(vertrag|vereinbarung|kündigung|kuendigung)/i.test(input)) return 'Verträge';
  if (/(steuer|finanzamt|umsatzsteuer|ekst)/i.test(input)) return 'Steuern';
  if (/(quittung|receipt|beleg|kassenbon)/i.test(input)) return 'Quittungen';
  if (/(arzt|praxis|rezept|befund|krankenhaus|medizin)/i.test(input)) return 'Medizin';
  for (const [k, v] of Object.entries(cfg.subfolder_synonyms || {})) {
    if (n.includes(norm(k))) return v;
  }
  for (const c of cfg.allowed_subfolders) {
    const cn = norm(c);
    if (n === cn || n.includes(cn)) return c;
  }
  if (cfg.allow_new_subfolders) {
    return String(input).replace(/[\\/]+/g, '').trim() || 'Sonstiges';
  }
  return bestAllowed(input, cfg.allowed_subfolders);
}

module.exports = { normalizeSubfolder, bestAllowed };
