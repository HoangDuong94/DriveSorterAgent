const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { google } = require('googleapis');
const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const pdfNaming = require('./utils/pdfNaming');
const ocr = require('./utils/ocr');
// Note: GCS is intentionally not used in simulate anymore
// const gcsVision = require('./utils/gcsVision');
require('dotenv').config();

// Timing/log helpers
const T0 = Date.now();
function logTS(msg) {
  const d = String(Date.now() - T0).padStart(5, ' ');
  console.log(`[+${d}ms] ${msg}`);
}

const streamPipeline = promisify(pipeline);

function requiredEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required env var: ${name}`);
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
  if (!fs.existsSync(keyFile)) throw new Error(`Google credentials file not found at ${keyFile}`);
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}

function loadPrompt() {
  const promptPath = path.join(process.cwd(), 'prompt.md');
  if (fs.existsSync(promptPath)) return fs.readFileSync(promptPath, 'utf-8');
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
  let pageToken;
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

function looksLikeId(v) {
  return typeof v === 'string' && /[A-Za-z0-9_-]{15,}/.test(v) && !/[\s/]/.test(v);
}

async function tryGetById(drive, id) {
  try {
    const res = await drive.files.get({ fileId: id, fields: 'id, name, mimeType', supportsAllDrives: true });
    return res.data;
  } catch (_) { return null; }
}

async function resolveFolderId(drive, idOrName) {
  if (looksLikeId(idOrName)) {
    const byId = await tryGetById(drive, idOrName);
    if (byId) return byId.id;
  }
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

async function findFolderId(drive, parentFolderId, folderName) {
  const res = await drive.files.list({
    q: `'${parentFolderId}' in parents and trashed = false and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 1,
  });
  if (res.data.files && res.data.files.length > 0) return res.data.files[0].id;
  return null;
}

async function downloadFile(drive, fileId, destPath) {
  const t = Date.now();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const writeStream = fs.createWriteStream(destPath);
  await streamPipeline(res.data, writeStream);
  try {
    const sz = (fs.statSync(destPath).size / 1024).toFixed(1);
    logTS(`Download abgeschlossen: ${sz} KiB in ${Date.now() - t}ms`);
  } catch {}
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
  if (mime.startsWith('image/')) {
    const b64 = fs.readFileSync(localPath, { encoding: 'base64' });
    const dataUrl = `data:${mime};base64,${b64}`;
    const resp = await client.responses.create({
      model: 'gpt-4o-mini',
      input: [{ role: 'user', content: [ { type: 'input_text', text: `${promptText}\nOriginal filename: ${originalName}` }, { type: 'input_image', image_url: dataUrl } ] }]
    });
    const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || JSON.stringify(resp);
    return { raw: text };
  }
  if (mime === 'application/pdf') {
    const dataBuffer = fs.readFileSync(localPath);
    const pdfData = await pdfParse(dataBuffer).catch(() => ({ text: '' }));
    const textSample = (pdfData.text || '').trim().slice(0, 8000);
    const resp = await client.responses.create({
      model: 'gpt-4o-mini',
      input: [{ role: 'user', content: [ { type: 'input_text', text: `${promptText}\nOriginal filename: ${originalName}\nInhalt (Auszug):\n${textSample}` } ] }]
    });
    const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || JSON.stringify(resp);
    return { raw: text };
  }
  const resp = await client.responses.create({
    model: 'gpt-4o-mini',
    input: [{ role: 'user', content: [ { type: 'input_text', text: `${promptText}\nOriginal filename: ${originalName}` } ] }]
  });
  const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || JSON.stringify(resp);
  return { raw: text };
}

async function analyzePdfWithOpenAIVision(pdfPath, originalName, promptText, maxPages = 0) {
  const client = new OpenAI.OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });
  let images = [];
  try {
    logTS(`Starte PDF→Bilder Rendering (maxPages=${maxPages || 'alle'}) für ${path.basename(pdfPath)}...`);
    const __t = Date.now();
    images = await ocr.pdfToPngs(pdfPath, path.join(process.cwd(), 'tmp', `img-${Date.now()}`), maxPages);
    logTS(`PDF Seiten gerendert: ${images.length} Bild(er) in ${Date.now() - __t}ms`);
  } catch (e) {
    console.warn('PDF→Image Konvertierung fehlgeschlagen (pdftoppm fehlt?):', e.message);
    return { ok: false, error: 'pdf_to_image_failed' };
  }
  if (!images.length) return { ok: false, error: 'no_images' };
  const content = [ { type: 'input_text', text: `${promptText}\nOriginal filename: ${originalName}` } ];
  for (const img of images) {
    const b64 = fs.readFileSync(img, { encoding: 'base64' });
    const dataUrl = `data:image/png;base64,${b64}`;
    content.push({ type: 'input_image', image_url: dataUrl });
  }
  const __ta = Date.now();
  const resp = await client.responses.create({ model: 'gpt-4o-mini', input: [ { role: 'user', content } ] });
  logTS(`Vision API Antwort nach ${Date.now() - __ta}ms`);
  const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || '';
  if (!text) return { ok: false, error: 'empty_response' };
  try { return { ok: true, parsed: JSON.parse(text) }; }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return { ok: true, parsed: JSON.parse(m[0]) }; } catch {} }
  }
  return { ok: false, error: 'bad_json', raw: text };
}

function parseJsonResponse(raw) {
  try { return JSON.parse(raw); }
  catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
  }
  throw new Error('KI-Antwort enthielt kein gültiges JSON');
}

async function main() {
  const promptText = loadPrompt();

  // Local mock mode detection
  const localArgIndex = process.argv.indexOf('--local');
  const localPathArg = localArgIndex >= 0 ? process.argv[localArgIndex + 1] : null;
  const preferredLocalDir = process.env.SIMULATE_LOCAL_DIR || localPathArg || '';
  const defaultMockDir = path.join(process.cwd(), 'tmp', 'mock_input');
  const fallbackTmpDir = path.join(process.cwd(), 'tmp');
  let useLocal = false;
  let localInputDir = '';
  if (preferredLocalDir) {
    localInputDir = path.isAbsolute(preferredLocalDir) ? preferredLocalDir : path.join(process.cwd(), preferredLocalDir);
    useLocal = true;
  } else if (fs.existsSync(defaultMockDir)) {
    localInputDir = defaultMockDir;
    useLocal = true;
  } else if (fs.existsSync(fallbackTmpDir)) {
    localInputDir = fallbackTmpDir;
    useLocal = true;
  }

  // Always bypass GCS in simulate: do not use gcsVision here

  if (useLocal) {
    // LOCAL MOCK MODE
    console.log(`> SIMULATION (LOCAL): Nutze Mockdaten aus "${localInputDir}"`);
    const entries = await fs.promises.readdir(localInputDir, { withFileTypes: true });
    // Only top-level files, ignore subfolders like generated img-* folders
    const files = entries
      .filter(d => d.isFile())
      .filter(d => /\.(pdf|png|jpg|jpeg|gif|webp)$/i.test(d.name))
      .map(d => ({ id: 'local', name: d.name, _localPath: path.join(localInputDir, d.name) }));
    if (!files.length) {
      console.log('Keine lokalen Mock-Dateien gefunden (erwartet z.B. in tmp/mock_input oder tmp).');
      return;
    }
    const summary = { processed: 0, planned: 0, errors: 0, details: [] };
    for (const file of files) {
      const localPath = file._localPath;
      try {
        console.log(`\nSIMULATION (LOCAL): Prüfe Datei: ${file.name}`);
        let newFilename;
        let targetFolderName;
        let source = 'openai';
        const mime = getMimeFromFilename(file.name);
        if (mime === 'application/pdf') {
          const allPages = process.argv.includes('--all-pages') || process.env.VISION_ALL_PAGES === '1';
          let maxPages = 0;
          if (!allPages) {
            const envPages = parseInt(process.env.VISION_MAX_PAGES || '3', 10);
            maxPages = isNaN(envPages) ? 3 : envPages;
          }
          const vis = await analyzePdfWithOpenAIVision(localPath, file.name, promptText, maxPages);
          if (vis.ok) {
            const parsed = vis.parsed;
            newFilename = parsed.new_filename || file.name;
            const ext = path.extname(file.name);
            if (!path.extname(newFilename)) newFilename = `${newFilename}${ext}`;
            const base = sanitizeFilenameBase(path.basename(newFilename, path.extname(newFilename)));
            newFilename = `${base}${path.extname(newFilename)}`;
            targetFolderName = parsed.target_folder || 'Sonstiges';
          } else {
            // Deterministic fallback
            source = 'fallback';
            const dataBuffer = fs.readFileSync(localPath);
            const pdfData = await pdfParse(dataBuffer).catch(() => ({ text: '' }));
            let text = (pdfData.text || '').trim();
            if (!text || text.length < 80) {
              const o = await ocr.ocrPdf(localPath, { maxPages: 2 }).catch(() => ({ text: '', used: false }));
              if (o && o.text) text = o.text;
            }
            const meta = pdfNaming.extractMetadataFromText(text);
            newFilename = pdfNaming.buildFilename(file.name, meta);
            targetFolderName = meta.category || 'Sonstiges';
          }
        } else {
          const analysis = await analyzeWithOpenAI(localPath, file.name, promptText);
          const parsed = parseJsonResponse(analysis.raw);
          newFilename = parsed.new_filename || file.name;
          const ext = path.extname(file.name);
          if (!path.extname(newFilename)) newFilename = `${newFilename}${ext}`;
          const base = sanitizeFilenameBase(path.basename(newFilename, path.extname(newFilename)));
          newFilename = `${base}${path.extname(newFilename)}`;
          targetFolderName = parsed.target_folder || 'Sonstiges';
        }
        console.log(`SIMULATION (LOCAL): Vorschlag von ${source}: "${newFilename}" -> Ordner "${targetFolderName}"`);
        summary.processed += 1;
        summary.planned += 1;
        summary.details.push({ file: file.name, to: `${targetFolderName}/${newFilename}`, source });
      } catch (err) {
        console.error(`SIMULATION (LOCAL): Fehler bei ${file.name}:`, err.message);
        summary.processed += 1;
        summary.errors += 1;
        summary.details.push({ file: file.name, error: err.message });
      }
    }
    console.log('\nSIMULATION (LOCAL): Zusammenfassung:');
    console.log(`- Verarbeitet: ${summary.processed}`);
    console.log(`- Geplante Moves: ${summary.planned}`);
    console.log(`- Fehler: ${summary.errors}`);
    const bySource = summary.details.reduce((acc, d) => { const k = d.source || 'error'; acc[k] = (acc[k]||0)+1; return acc; }, {});
    console.log(`- Quellen: OpenAI=${bySource.openai||0}, Fallback=${bySource.fallback||0}`);
    return;
  }

  // DRIVE MODE (keine GCS-Nutzung, nur OpenAI)
  const SOURCE_FOLDER_ENV = requiredEnv('SOURCE_FOLDER_ID');
  const TARGET_ROOT_FOLDER_ENV = requiredEnv('TARGET_ROOT_FOLDER_ID');
  const drive = await initDrive();
  console.log('> SIMULATION: Verbinde mit Google Drive und lese Dateien...');
  let _t = Date.now();
  const SOURCE_FOLDER_ID = await resolveFolderId(drive, SOURCE_FOLDER_ENV);
  logTS(`Ordnerauflösung SOURCE fertig in ${Date.now() - _t}ms`);
  _t = Date.now();
  const TARGET_ROOT_FOLDER_ID = await resolveFolderId(drive, TARGET_ROOT_FOLDER_ENV);
  logTS(`Ordnerauflösung TARGET_ROOT fertig in ${Date.now() - _t}ms`);
  _t = Date.now();
  const files = await listFilesInFolder(drive, SOURCE_FOLDER_ID);
  logTS(`Listing fertig (${files.length} Dateien) in ${Date.now() - _t}ms`);
  if (!files.length) { console.log('Keine Dateien im Eingangsordner gefunden.'); return; }
  console.log(`Gefundene Dateien: ${files.length}`);

  const tmpDir = path.join(process.cwd(), 'tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const summary = { processed: 0, planned: 0, errors: 0, details: [] };

  for (const file of files) {
    const safeLocalName = `${file.id}-${file.name}`
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/[\x00-\x1F]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
    const localPath = path.join(tmpDir, safeLocalName);
    try {
      console.log(`\nSIMULATION: Prüfe Datei: ${file.name} (${file.id})`);
      await downloadFile(drive, file.id, localPath);
      let newFilename;
      let targetFolderName;
      let source = 'openai';
      const mime = getMimeFromFilename(file.name);
      if (mime === 'application/pdf') {
        const allPages = process.argv.includes('--all-pages') || process.env.VISION_ALL_PAGES === '1';
        let maxPages = 0;
        if (!allPages) {
          const envPages = parseInt(process.env.VISION_MAX_PAGES || '3', 10);
          maxPages = isNaN(envPages) ? 3 : envPages;
        }
        const vis = await analyzePdfWithOpenAIVision(localPath, file.name, promptText, maxPages);
        if (vis.ok) {
          const parsed = vis.parsed;
          newFilename = parsed.new_filename || file.name;
          const ext = path.extname(file.name);
          if (!path.extname(newFilename)) newFilename = `${newFilename}${ext}`;
          const base = sanitizeFilenameBase(path.basename(newFilename, path.extname(newFilename)));
          newFilename = `${base}${path.extname(newFilename)}`;
          targetFolderName = parsed.target_folder || 'Sonstiges';
        } else {
          // Deterministic fallback
          source = 'fallback';
          const dataBuffer = fs.readFileSync(localPath);
          const pdfData = await pdfParse(dataBuffer).catch(() => ({ text: '' }));
          let text = (pdfData.text || '').trim();
          if (!text || text.length < 80) {
            const o = await ocr.ocrPdf(localPath, { maxPages: 2 }).catch(() => ({ text: '', used: false }));
            if (o && o.text) text = o.text;
          }
          const meta = pdfNaming.extractMetadataFromText(text);
          newFilename = pdfNaming.buildFilename(file.name, meta);
          targetFolderName = meta.category || 'Sonstiges';
        }
      } else {
        const analysis = await analyzeWithOpenAI(localPath, file.name, promptText);
        const parsed = parseJsonResponse(analysis.raw);
        newFilename = parsed.new_filename || file.name;
        const ext = path.extname(file.name);
        if (!path.extname(newFilename)) newFilename = `${newFilename}${ext}`;
        const base = sanitizeFilenameBase(path.basename(newFilename, path.extname(newFilename)));
        newFilename = `${base}${path.extname(newFilename)}`;
        targetFolderName = parsed.target_folder || 'Sonstiges';
      }
      const exists = await findFolderId(drive, TARGET_ROOT_FOLDER_ID, targetFolderName);
      const folderStatus = exists ? 'Ordner existiert' : 'Ordner würde erstellt werden';
      console.log(`SIMULATION: Vorschlag von ${source}: "${newFilename}" -> Ordner "${targetFolderName}" (${folderStatus})`);
      summary.processed += 1;
      summary.planned += 1;
      summary.details.push({ file: file.name, to: `${targetFolderName}/${newFilename}`, source, note: folderStatus });
    } catch (err) {
      console.error(`SIMULATION: Fehler bei ${file.name}:`, err.message);
      summary.processed += 1;
      summary.errors += 1;
      summary.details.push({ file: file.name, error: err.message });
    } finally {
      try { await fs.promises.unlink(localPath); } catch {}
    }
  }

  console.log('\nSIMULATION: Zusammenfassung:');
  console.log(`- Verarbeitet: ${summary.processed}`);
  console.log(`- Geplante Moves: ${summary.planned}`);
  console.log(`- Fehler: ${summary.errors}`);
  const bySource = summary.details.reduce((acc, d) => { const k = d.source || 'error'; acc[k] = (acc[k]||0)+1; return acc; }, {});
  console.log(`- Quellen: OpenAI=${bySource.openai||0}, Fallback=${bySource.fallback||0}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('SIMULATION: Unerwarteter Fehler:', err);
    process.exit(1);
  });
}
