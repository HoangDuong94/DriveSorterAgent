const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { createWorker } = require('tesseract.js');

const execFileAsync = promisify(execFile);

function resolvePdftoppmCmd() {
  const explicit = process.env.PDFTOPPM_PATH || process.env.POPPLER_BIN || process.env.POPPLER_PATH;
  return explicit && explicit.trim() ? explicit.trim() : 'pdftoppm';
}

function resolvePdfinfoCmd() {
  const explicit = process.env.PDFINFO_PATH || process.env.POPPLER_BIN || process.env.POPPLER_PATH;
  return explicit && explicit.trim() ? explicit.trim().replace(/pdftoppm(?:\.exe)?$/i, 'pdfinfo') : 'pdfinfo';
}

async function hasPdftoppm() {
  const cmd = resolvePdftoppmCmd();
  try {
    await execFileAsync(cmd, ['-v']);
    return true;
  } catch (e) {
    return false;
  }
}

async function getPdfPageCount(pdfPath) {
  const cmd = resolvePdfinfoCmd();
  try {
    const { stdout } = await execFileAsync(cmd, [pdfPath]);
    const m = stdout.match(/Pages:\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
  } catch {}
  return null;
}

async function pdfToPngs(pdfPath, outDir, maxPages) {
  await fs.promises.mkdir(outDir, { recursive: true });
  const outPrefix = path.join(outDir, 'page');
  const dpi = parseInt(process.env.OCR_DPI || '300', 10);
  const args = ['-png', '-rx', String(dpi), '-ry', String(dpi)];
  if (maxPages && Number(maxPages) > 0) {
    args.push('-f', '1', '-l', String(maxPages));
  }
  args.push(pdfPath, outPrefix);
  const cmd = resolvePdftoppmCmd();
  const debug = process.env.OCR_DEBUG === '1';
  if (debug) {
    // Mask path for readability
    console.log(`[OCR] Running: ${cmd} ${args.join(' ')}`);
  }
  const t0 = Date.now();
  const timeoutMs = parseInt(process.env.OCR_TIMEOUT_MS || '600000', 10); // default 10 minutes for large PDFs
  await execFileAsync(cmd, args, { timeout: timeoutMs, windowsHide: true });
  if (debug) {
    console.log(`[OCR] pdftoppm finished in ${Date.now() - t0}ms`);
  }
  const files = await fs.promises.readdir(outDir);
  return files
    .filter(f => /^page-\d+\.png$/i.test(f))
    .map(f => path.join(outDir, f))
    .sort((a, b) => a.localeCompare(b));
}

async function ocrImage(imagePath, lang = 'deu+eng') {
  const worker = await createWorker(lang);
  try {
    const { data: { text } } = await worker.recognize(imagePath);
    return text || '';
  } finally {
    await worker.terminate();
  }
}

async function ocrPdf(pdfPath, options = {}) {
  const { maxPages = 1, lang = 'deu+eng', tmpDir = path.join(os.tmpdir(), 'drivesorter-ocr') } = options;
  const available = await hasPdftoppm();
  if (!available) {
    return { text: '', used: false, reason: 'pdftoppm_not_found' };
  }
  const workDir = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  const images = await pdfToPngs(pdfPath, workDir, maxPages);
  let fullText = '';
  for (const img of images) {
    const t = await ocrImage(img, lang).catch(() => '');
    fullText += (t || '') + '\n';
  }
  // cleanup best-effort
  try { await fs.promises.rm(workDir, { recursive: true, force: true }); } catch {}
  return { text: fullText.trim(), used: true };
}

module.exports = {
  hasPdftoppm,
  pdfToPngs,
  ocrImage,
  ocrPdf,
  getPdfPageCount,
};
