const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { google } = require('googleapis');
const gcsVision = require('./utils/gcsVision');
require('dotenv').config();

const streamPipeline = promisify(pipeline);

function requiredEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function initDrive() {
  const keyFile = requiredEnv('GOOGLE_APPLICATION_CREDENTIALS');
  if (!fs.existsSync(keyFile)) throw new Error(`Google credentials file not found at ${keyFile}`);
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}

async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 1000,
      pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return files;
}

async function resolveFolderId(drive, idOrName) {
  // If it looks like an ID, return it
  if (/^[A-Za-z0-9_-]{15,}$/.test(idOrName)) return idOrName;
  const res = await drive.files.list({
    q: `name = '${idOrName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 1,
  });
  if (res.data.files && res.data.files.length) return res.data.files[0].id;
  throw new Error(`Folder not found: ${idOrName}`);
}

async function downloadFile(drive, fileId, destPath) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const writeStream = fs.createWriteStream(destPath);
  await streamPipeline(res.data, writeStream);
}

function getMimeFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

async function main() {
  if (!process.env.GCS_BUCKET) throw new Error('GCS_BUCKET is not set');
  const SOURCE = requiredEnv('SOURCE_FOLDER_ID');
  const drive = await initDrive();
  const sourceId = await resolveFolderId(drive, SOURCE);

  const files = await listFilesInFolder(drive, sourceId);
  const pdfs = files.filter(f => (f.mimeType === 'application/pdf') || getMimeFromFilename(f.name) === 'application/pdf');
  if (!pdfs.length) { console.log('Keine PDF-Dateien gefunden.'); return; }

  const outDir = path.join(process.cwd(), 'tmp', 'gcs_text');
  await fs.promises.mkdir(outDir, { recursive: true });

  for (const f of pdfs) {
    const localPath = path.join(process.cwd(), 'tmp', `${f.id}-${f.name}`.replace(/[<>:"/\\|?*]/g, '-'));
    console.log(`\nPDF: ${f.name} (${f.id})`);
    await downloadFile(drive, f.id, localPath);
    const res = await gcsVision.ocrPdfViaGCS(localPath, { bucket: process.env.GCS_BUCKET, prefix: process.env.GCS_PREFIX });
    const text = res.text || '';
    const outPath = path.join(outDir, `${f.id}.txt`);
    await fs.promises.writeFile(outPath, text, 'utf-8');
    console.log(`OCR-Text gespeichert: ${outPath}`);
    // Print a short preview to console
    const preview = text.slice(0, 1200).replace(/\r/g, '');
    console.log('Vorschau (erste ~1200 Zeichen):');
    console.log('---');
    console.log(preview);
    console.log('---');
  }
}

if (require.main === module) {
  main().catch(err => { console.error('Fehler:', err.message); process.exit(1); });
}

