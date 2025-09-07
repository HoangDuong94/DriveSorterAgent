const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { google } = require('googleapis');
const OpenAI = require('openai');
const pdfNaming = require('./utils/pdfNaming');
const gcsVision = require('./utils/gcsVision');
require('dotenv').config();

const streamPipeline = promisify(pipeline);

function requiredEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function getMimeFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

async function initDrive() {
  const keyFile = requiredEnv('GOOGLE_APPLICATION_CREDENTIALS');
  if (!fs.existsSync(keyFile)) {
    throw new Error(`Google credentials file not found at ${keyFile}`);
  }
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  const drive = google.drive({ version: 'v3', auth });
  return drive;
}

function loadPrompt() {
  const promptPath = path.join(process.cwd(), 'prompt.md');
  if (fs.existsSync(promptPath)) {
    return fs.readFileSync(promptPath, 'utf-8');
  }
  return `Du bist ein Assistent, der Dateiinhalte analysiert und präzise, maschinenlesbare JSON-Antworten erzeugt.
Antwortformat (ohne zusätzliche Erklärungen):
{"new_filename": "<neuer_dateiname_mit_endung>", "target_folder": "<zielordner_name>"}
Regeln:
- new_filename: kurz, sprechend, nur [a-zA-Z0-9-_], ersetze Leerzeichen mit '-', behalte die ursprüngliche Dateiendung bei.
- target_folder: thematischer Ordnername (z.B. "Rechnungen", "Versicherungen", "Bank", "Verträge").
- Antworte ausschließlich mit JSON, kein Markdown, keine Kommentare.`;
}

async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken = undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, parents)',
      spaces: 'drive',
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

async function ensureFolderExists(drive, parentFolderId, folderName) {
  const res = await drive.files.list({
    q: `'${parentFolderId}' in parents and trashed = false and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    },
    fields: 'id, name',
    supportsAllDrives: true,
  });
  return createRes.data.id;
}

async function findFolderId(drive, parentFolderId, folderName) {
  const res = await drive.files.list({
    q: `'${parentFolderId}' in parents and trashed = false and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 1,
  });
  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }
  return null;
}

function looksLikeId(v) {
  return typeof v === 'string' && /[A-Za-z0-9_-]{15,}/.test(v) && !/[\s/]/.test(v);
}

async function tryGetById(drive, id) {
  try {
    const res = await drive.files.get({ fileId: id, fields: 'id, name, mimeType', supportsAllDrives: true });
    return res.data;
  } catch (_) {
    return null;
  }
}

async function resolveFolderId(drive, idOrName) {
  // If it looks like an ID, verify it exists
  if (looksLikeId(idOrName)) {
    const byId = await tryGetById(drive, idOrName);
    if (byId) return byId.id;
  }
  // Search by name across Drive
  const res = await drive.files.list({
    q: `name = '${idOrName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name, parents)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 10,
  });
  if (res.data.files && res.data.files.length) {
    const match = res.data.files[0];
    console.log(`Hinweis: Ordner "${idOrName}" auf ID ${match.id} aufgelöst.`);
    return match.id;
  }
  throw new Error(`Ordner nicht gefunden oder Zugriff fehlt: ${idOrName}`);
}

async function downloadFile(drive, fileId, destPath) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const writeStream = fs.createWriteStream(destPath);
  await streamPipeline(res.data, writeStream);
}

function sanitizeFilenameBase(name) {
  return name
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\-_.]/g, '')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .substring(0, 120);
}

async function analyzeWithOpenAI(localPath, originalName, promptText) {
  const client = new OpenAI.OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });
  const mime = getMimeFromFilename(originalName);
  const ext = path.extname(originalName);

  // For images: send as data URL to GPT-4o-mini vision
  if (mime.startsWith('image/')) {
    const b64 = fs.readFileSync(localPath, { encoding: 'base64' });
    const dataUrl = `data:${mime};base64,${b64}`;
    const resp = await client.responses.create({
      model: 'gpt-4o-mini',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: `${promptText}\nOriginal filename: ${originalName}` },
            { type: 'input_image', image_url: dataUrl },
          ]
        }
      ]
    });
    const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || JSON.stringify(resp);
    return { raw: text };
  }

  // For PDFs: handled via GCS OCR or local OCR elsewhere; skip here
  if (mime === 'application/pdf') return { raw: '{}' };

  // Fallback: send only filename info
  const resp = await client.responses.create({
    model: 'gpt-4o-mini',
    input: [
      { role: 'user', content: [ { type: 'input_text', text: `${promptText}\nOriginal filename: ${originalName}` } ] }
    ]
  });
  const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || JSON.stringify(resp);
  return { raw: text };
}

async function analyzePdfWithOpenAIVision(pdfPath, originalName, promptText, maxPages = 0) {
  const client = new OpenAI.OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });
  // Convert first pages of PDF to images using pdftoppm via our ocr util
  let images = [];
  try {
    images = await ocr.pdfToPngs(pdfPath, path.join(process.cwd(), 'tmp', `img-${Date.now()}`), maxPages);
  } catch (e) {
    console.warn('PDF→Image Konvertierung fehlgeschlagen (pdftoppm fehlt?):', e.message);
    return { ok: false, error: 'pdf_to_image_failed' };
  }
  if (!images.length) return { ok: false, error: 'no_images' };

  const content = [
    { type: 'input_text', text: `${promptText}\nOriginal filename: ${originalName}` }
  ];
  for (const img of images) {
    const mime = 'image/png';
    const b64 = fs.readFileSync(img, { encoding: 'base64' });
    const dataUrl = `data:${mime};base64,${b64}`;
    content.push({ type: 'input_image', image_url: dataUrl });
  }
  const resp = await client.responses.create({
    model: 'gpt-4o-mini',
    input: [ { role: 'user', content } ]
  });
  const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || '';
  if (!text) return { ok: false, error: 'empty_response' };
  let parsed;
  try { parsed = parseJsonResponse(text); } catch (_) { return { ok: false, error: 'bad_json', raw: text }; }
  return { ok: true, parsed };
}

function parseJsonResponse(raw) {
  try {
    // Try direct JSON
    return JSON.parse(raw);
  } catch (e) {
    // Try to extract JSON substring
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
  }
  throw new Error('KI-Antwort enthielt kein gültiges JSON');
}

async function renameAndMove(drive, file, newName, targetFolderId, sourceFolderId) {
  // Rename
  await drive.files.update({ fileId: file.id, requestBody: { name: newName } });
  // Move between parents
  await drive.files.update({
    fileId: file.id,
    addParents: targetFolderId,
    removeParents: (file.parents && file.parents.length ? file.parents.join(',') : sourceFolderId),
    fields: 'id, parents'
  });
}

async function main() {
  const SOURCE_FOLDER_ENV = requiredEnv('SOURCE_FOLDER_ID');
  const TARGET_ROOT_FOLDER_ENV = requiredEnv('TARGET_ROOT_FOLDER_ID');
  const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
  const promptText = loadPrompt();

  const drive = await initDrive();
  console.log('> Verbinde mit Google Drive und lese Dateien...');
  const SOURCE_FOLDER_ID = await resolveFolderId(drive, SOURCE_FOLDER_ENV);
  const TARGET_ROOT_FOLDER_ID = await resolveFolderId(drive, TARGET_ROOT_FOLDER_ENV);
  const files = await listFilesInFolder(drive, SOURCE_FOLDER_ID);
  if (!files.length) {
    console.log('Keine Dateien im Eingangsordner gefunden.');
    return;
  }
  console.log(`Gefundene Dateien: ${files.length}`);

  const tmpDir = path.join(process.cwd(), 'tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const summary = { processed: 0, moved: 0, skipped: 0, errors: 0, details: [] };

  for (const file of files) {
    const safeLocalName = `${file.id}-${file.name}`
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/[\x00-\x1F]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    const localPath = path.join(tmpDir, safeLocalName);
    try {
      console.log(`\nVerarbeite: ${file.name} (${file.id})`);
      await downloadFile(drive, file.id, localPath);

      const mime = getMimeFromFilename(file.name);
      let newFilename;
      let targetFolderName;
      if (mime === 'application/pdf') {
        if (!process.env.GCS_BUCKET) {
          throw new Error('GCS_BUCKET ist nicht konfiguriert; PDF-OCR ist deaktiviert');
        }
        const res = await gcsVision.ocrPdfViaGCS(localPath, { bucket: process.env.GCS_BUCKET, prefix: process.env.GCS_PREFIX });
        const text = res.text || '';
        const meta = pdfNaming.extractMetadataFromText(text);
        newFilename = pdfNaming.buildFilename(file.name, meta);
        targetFolderName = meta.category || 'Sonstiges';
      } else {
        const analysis = await analyzeWithOpenAI(localPath, file.name, promptText);
        const parsed = parseJsonResponse(analysis.raw);
        newFilename = parsed.new_filename || file.name;
        const ext = path.extname(file.name);
        if (!path.extname(newFilename)) {
          newFilename = `${newFilename}${ext}`;
        }
        const base = sanitizeFilenameBase(path.basename(newFilename, path.extname(newFilename)));
        newFilename = `${base}${path.extname(newFilename)}`;
        targetFolderName = parsed.target_folder || 'Sonstiges';
      }

      const targetFolderId = await ensureFolderExists(drive, TARGET_ROOT_FOLDER_ID, targetFolderName);

      await renameAndMove(drive, file, newFilename, targetFolderId, SOURCE_FOLDER_ID);
      console.log(`✔ Umbenannt in "${newFilename}" und verschoben nach "${targetFolderName}"`);
      summary.processed += 1;
      summary.moved += 1;
      summary.details.push({ file: file.name, to: `${targetFolderName}/${newFilename}` });
    } catch (err) {
      console.error(`✖ Fehler bei ${file.name}:`, err.message);
      summary.processed += 1;
      summary.errors += 1;
      summary.details.push({ file: file.name, error: err.message });
    } finally {
      // cleanup temp
      try { await fs.promises.unlink(localPath); } catch {}
    }
  }

  console.log('\nZusammenfassung:');
  console.log(`- Verarbeitet: ${summary.processed}`);
  console.log(`- Verschoben:  ${summary.moved}`);
  console.log(`- Fehler:      ${summary.errors}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Unerwarteter Fehler:', err);
    process.exit(1);
  });
}

