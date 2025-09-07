const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { google } = require('googleapis');
const OpenAI = require('openai');
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

async function listFoldersAndFiles(drive, rootFolderId) {
  const res = await drive.files.list({
    q: `'${rootFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id,name)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 1000,
  });
  const folders = res.data.files || [];
  const lines = [];
  for (const f of folders) {
    lines.push(`FOLDER: ${f.name}`);
    const rf = await drive.files.list({
      q: `'${f.id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'files(name)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 1000,
    });
    const fileNames = (rf.data.files || []).map(x => x.name);
    if (fileNames.length) {
      for (const n of fileNames) lines.push(`- ${n}`);
    } else {
      lines.push('- (leer)');
    }
  }
  if (!folders.length) lines.push('FOLDER: (keine)');
  return lines.join('\n');
}

function getMimeFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

async function proposeFromText(documentText, originalName, foldersContext, promptText) {
  const client = new OpenAI.OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });
  const sys = `Du bist ein präziser Dokumentenanalyst und Dateibenenner. Antworte ausschließlich mit einem JSON-Objekt der Form {"new_filename":"...","target_folder":"..."}. Verwende niemals den Namen des Benutzers (z. B. 'Minh Hoang Duong') oder andere personenbezogene Namen im Dateinamen.`;
  const rules = `Regeln:\n- Behalte die Dateiendung des Originals bei.\n- new_filename: nur [a-zA-Z0-9-_.], Leerzeichen zu '-', kurz und sprechend.\n- Verwende KEINE persönlichen Namen des Benutzers im Dateinamen.\n- target_folder: nutze einen existierenden Ordner falls passend, sonst schlage einen neuen prägnanten Ordnernamen vor.\n- Keine Zusatztexte, kein Markdown, nur JSON.`;
  const content = [
    { type: 'input_text', text: sys },
    { type: 'input_text', text: promptText },
    { type: 'input_text', text: rules },
    { type: 'input_text', text: `Original filename: ${originalName}` },
    { type: 'input_text', text: `Aktuelle Ordner & Dateien:\n${foldersContext}` },
    { type: 'input_text', text: `Dokumenttext (OCR, ggf. gekürzt):\n${(documentText||'').slice(0, 12000)}` },
  ];
  const resp = await client.responses.create({ model: 'gpt-4o-mini', input: [ { role: 'user', content } ] });
  const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || '';
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('OpenAI Antwort nicht als JSON parsebar');
}

async function main() {
  if (!process.env.GCS_BUCKET) throw new Error('GCS_BUCKET is not set');
  const SOURCE = requiredEnv('SOURCE_FOLDER_ID');
  const TARGET = requiredEnv('TARGET_ROOT_FOLDER_ID');
  const drive = await initDrive();
  const sourceId = await resolveFolderId(drive, SOURCE);
  const targetId = await resolveFolderId(drive, TARGET);
  const promptText = fs.existsSync('prompt.md') ? fs.readFileSync('prompt.md','utf-8') : '';

  const foldersContext = await listFoldersAndFiles(drive, targetId);
  const files = await listFilesInFolder(drive, sourceId);
  if (!files.length) { console.log('Keine Dateien im Eingangsordner gefunden.'); return; }

  const tmpDir = path.join(process.cwd(), 'tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  for (const file of files) {
    const localPath = path.join(tmpDir, `${file.id}-${file.name}`.replace(/[<>:"/\\|?*]/g, '-'));
    await downloadFile(drive, file.id, localPath);
    try {
      console.log(`\nDatei: ${file.name} (${file.id})`);
      let proposal;
      if (getMimeFromFilename(file.name) === 'application/pdf') {
        const res = await gcsVision.ocrPdfViaGCS(localPath, { bucket: process.env.GCS_BUCKET, prefix: process.env.GCS_PREFIX });
        proposal = await proposeFromText(res.text || '', file.name, foldersContext, promptText);
      } else {
        // For images, reuse the text path by sending a short placeholder and relying on filename context
        proposal = await proposeFromText('', file.name, foldersContext, promptText);
      }
      const ext = path.extname(file.name);
      let newName = proposal.new_filename || file.name;
      if (!path.extname(newName)) newName = `${newName}${ext}`;
      const base = newName.slice(0, newName.length - path.extname(newName).length)
        .replace(/\s+/g,'-').replace(/[^a-zA-Z0-9-_.]/g,'').toLowerCase();
      newName = `${base}${path.extname(newName)}`;
      console.log(`Vorschlag: folder="${proposal.target_folder || 'Sonstiges'}" filename="${newName}"`);
    } catch (e) {
      console.error('Fehler bei Vorschlag:', e.message);
    } finally {
      try { await fs.promises.unlink(localPath); } catch {}
    }
  }
}

if (require.main === module) {
  main().catch(err => { console.error('Fehler:', err.message); process.exit(1); });
}
// Clean, read-only suggest script with detailed filename rules and examples
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { google } = require('googleapis');
const OpenAI = require('openai');
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

async function listFoldersAndFiles(drive, rootFolderId) {
  const res = await drive.files.list({
    q: `'${rootFolderId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id,name)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 1000,
  });
  const folders = res.data.files || [];
  const lines = [];
  for (const f of folders) {
    lines.push(`FOLDER: ${f.name}`);
    const rf = await drive.files.list({
      q: `'${f.id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'files(name)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 1000,
    });
    const fileNames = (rf.data.files || []).map(x => x.name);
    if (fileNames.length) {
      for (const n of fileNames) lines.push(`- ${n}`);
    } else {
      lines.push('- (leer)');
    }
  }
  if (!folders.length) lines.push('FOLDER: (keine)');
  return lines.join('\n');
}

function getMimeFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

async function proposeFromText(documentText, originalName, foldersContext, promptText) {
  const client = new OpenAI.OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });
  const sys = `Du bist ein praeziser Dokumentenanalyst und Dateibenenner. Antworte ausschliesslich mit einem JSON-Objekt der Form {"new_filename":"...","target_folder":"..."}. Verwende niemals den Namen des Benutzers oder andere personenbezogene Namen im Dateinamen.`;
  const rules = `Regeln:\n- Behalte die Dateiendung des Originals bei.\n- new_filename: nur [a-zA-Z0-9-_.], Leerzeichen zu '-', alles in Kleinbuchstaben.\n- Der Dateiname soll AUSFUEHRLICH sein: enthalte Dokumenttyp (z. B. rechnung, veranlagungsverfuegung, vorsorgeausweis, police, vertrag, kontoauszug), Absender/Institution (kurz), Datum als YYYY-MM-DD (falls verfuegbar) und relevante Kennzeichen (z. B. rechnungsnummer/aktenzeichen).\n- Verwende KEINE persoenlichen Namen des Benutzers im Dateinamen.\n- target_folder: nutze einen existierenden Ordner falls passend, sonst schlage einen neuen praegnanten, thematischen Ordnernamen vor (z. B. Rechnungen, Steuern, Versicherungen, Medizin, Bank, Vertraege).\n- Keine Zusatztexte, kein Markdown, nur JSON.\nBeispiele fuer new_filename:\n- rechnung-acme-gmbh-2024-08-15-12345.pdf\n- veranlagungsverfuegung-stadt-luzern-2024-08-19.pdf\n- vorsorgeausweis-servisa-2025-07-23.pdf\n- police-allianz-haftpflicht-2025-02-01.pdf\n- arbeitsvertrag-contoso-2023-11-01.pdf\n- kontoauszug-zkb-2025-01.pdf`;
  const content = [
    { type: 'input_text', text: sys },
    { type: 'input_text', text: promptText || '' },
    { type: 'input_text', text: rules },
    { type: 'input_text', text: `Original filename: ${originalName}` },
    { type: 'input_text', text: `Aktuelle Ordner & Dateien:\n${foldersContext}` },
    { type: 'input_text', text: `Dokumenttext (OCR, ggf. gekuerzt):\n${(documentText||'').slice(0, 12000)}` },
  ];
  const resp = await client.responses.create({ model: 'gpt-4o-mini', input: [ { role: 'user', content } ] });
  const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || '';
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('OpenAI Antwort nicht als JSON parsebar');
}

async function main() {
  if (!process.env.GCS_BUCKET) throw new Error('GCS_BUCKET is not set');
  const SOURCE = requiredEnv('SOURCE_FOLDER_ID');
  const TARGET = requiredEnv('TARGET_ROOT_FOLDER_ID');
  const drive = await initDrive();
  const sourceId = await resolveFolderId(drive, SOURCE);
  const targetId = await resolveFolderId(drive, TARGET);
  const promptText = fs.existsSync('prompt.md') ? fs.readFileSync('prompt.md','utf-8') : '';

  const foldersContext = await listFoldersAndFiles(drive, targetId);
  const files = await listFilesInFolder(drive, sourceId);
  if (!files.length) { console.log('Keine Dateien im Eingangsordner gefunden.'); return; }

  const tmpDir = path.join(process.cwd(), 'tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  for (const file of files) {
    const localPath = path.join(tmpDir, `${file.id}-${file.name}`.replace(/[<>:"/\\|?*]/g, '-'));
    await downloadFile(drive, file.id, localPath);
    try {
      console.log(`\nDatei: ${file.name} (${file.id})`);
      let proposal;
      if (getMimeFromFilename(file.name) === 'application/pdf') {
        const res = await gcsVision.ocrPdfViaGCS(localPath, { bucket: process.env.GCS_BUCKET, prefix: process.env.GCS_PREFIX });
        proposal = await proposeFromText(res.text || '', file.name, foldersContext, promptText);
      } else {
        proposal = await proposeFromText('', file.name, foldersContext, promptText);
      }
      const ext = path.extname(file.name);
      let newName = proposal.new_filename || file.name;
      if (!path.extname(newName)) newName = `${newName}${ext}`;
      const base = newName.slice(0, newName.length - path.extname(newName).length)
        .replace(/\s+/g,'-').replace(/[^a-zA-Z0-9-_.]/g,'').toLowerCase();
      newName = `${base}${path.extname(newName)}`;
      console.log(`Vorschlag: folder="${proposal.target_folder || 'Sonstiges'}" filename="${newName}"`);
    } catch (e) {
      console.error('Fehler bei Vorschlag:', e.message);
    } finally {
      try { await fs.promises.unlink(localPath); } catch {}
    }
  }
}

if (require.main === module) {
  main().catch(err => { console.error('Fehler:', err.message); process.exit(1); });
}
