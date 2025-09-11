function extractId(idOrUrl) {
  if (!idOrUrl) return null;
  const s = String(idOrUrl).trim();
  if (/^[A-Za-z0-9_-]{15,}$/.test(s)) return s;
  const m1 = s.match(/\/folders\/([A-Za-z0-9_-]{15,})/);
  if (m1) return m1[1];
  const m2 = s.match(/\/file\/d\/([A-Za-z0-9_-]{15,})/);
  if (m2) return m2[1];
  const m3 = s.match(/[?&]id=([A-Za-z0-9_-]{15,})/);
  if (m3) return m3[1];
  return null;
}

module.exports = { extractId };

