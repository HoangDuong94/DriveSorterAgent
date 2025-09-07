const path = require('path');

function sanitizeBase(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\-_.]/g, '')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .toLowerCase()
    .slice(0, 120);
}

function extractDateISO(text) {
  if (!text) return null;
  // dd.mm.yyyy
  const m1 = text.match(/\b(\d{1,2})[.](\d{1,2})[.](\d{4})\b/);
  if (m1) {
    const [ , d, m, y ] = m1;
    const dd = String(d).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }
  // yyyy-mm-dd
  const m2 = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m2) {
    const [ , y, m, d ] = m2;
    return `${y}-${m}-${d}`;
  }
  return null;
}

function extractInvoiceNumber(text) {
  if (!text) return null;
  const patterns = [
    /Rechnungsnummer\s*[:#]?\s*([A-Za-z0-9\-\/]{3,})/i,
    /Rechnung(?:s)?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9\-\/]{3,})/i,
    /Invoice\s*(?:No\.?|Number)\s*[:#]?\s*([A-Za-z0-9\-\/]{3,})/i,
    /Belegnummer\s*[:#]?\s*([A-Za-z0-9\-\/]{3,})/i,
  ];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m) return m[1];
  }
  return null;
}

function extractSender(text) {
  if (!text) return null;
  const firstLines = text.split(/\r?\n/).slice(0, 10).join('\n');
  const companySuffix = '(?:GmbH|AG|UG|e\\.V\\.|KG|OHG|GmbH & Co\\.|Ltd\\.|LLC)';
  const rxAfterInvoice = new RegExp(`Rechnung[^\\n]{0,50}?([A-Z][A-Za-z0-9&.,\\- ]{2,}?\\s${companySuffix})`);
  let m = firstLines.match(rxAfterInvoice);
  if (m) return m[1];
  const rxCompany = new RegExp(`\\b([A-Z][A-Za-z0-9&.,\\- ]{2,}?\\s${companySuffix})\\b`);
  m = firstLines.match(rxCompany);
  if (m) return m[1];
  const candidate = text.split(/\r?\n/).find(l => /[A-Z][A-Za-z]+/.test(l) && l.length < 80);
  if (candidate) return candidate.trim();
  return null;
}

function classifyCategory(text) {
  if (!text) return 'Sonstiges';
  const t = text.toLowerCase();
  if (/(rechnung|invoice|zahlung|ust|mwst|iban|betrag)/i.test(text)) return 'Rechnungen';
  if (/(versicherung|police|schadennummer)/i.test(text)) return 'Versicherungen';
  if (/(kontoauszug|bank|überweisung|ueberweisung|sepa|lastschrift)/i.test(t)) return 'Bank';
  if (/(vertrag|vereinbarung|kündigung|kuendigung)/i.test(t)) return 'Verträge';
  if (/(steuer|finanzamt|ekst|umsatzsteuer)/i.test(t)) return 'Steuern';
  if (/(quittung|beleg|kassenbon)/i.test(t)) return 'Quittungen';
  if (/(arzt|praxis|rezept|befund|krankenhaus)/i.test(t)) return 'Medizin';
  return 'Sonstiges';
}

function buildFilename(originalName, meta) {
  const ext = path.extname(originalName) || '.pdf';
  const parts = [];
  const category = (meta.category || 'dokument').toLowerCase();
  parts.push(category);
  if (meta.sender) parts.push(sanitizeBase(meta.sender));
  if (meta.dateISO) parts.push(meta.dateISO);
  if (meta.invoiceNumber) parts.push(sanitizeBase(meta.invoiceNumber));
  const base = sanitizeBase(parts.filter(Boolean).join('-')) || 'dokument';
  return `${base}${ext}`;
}

function extractMetadataFromText(text) {
  const dateISO = extractDateISO(text);
  const invoiceNumber = extractInvoiceNumber(text);
  const sender = extractSender(text);
  const category = classifyCategory(text);
  return { dateISO, invoiceNumber, sender, category };
}

module.exports = {
  sanitizeBase,
  extractDateISO,
  extractInvoiceNumber,
  extractSender,
  classifyCategory,
  extractMetadataFromText,
  buildFilename,
};
