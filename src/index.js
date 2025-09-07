const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { google } = require('googleapis');
const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const pdfNaming = require('./utils/pdfNaming');
const gcsVision = require('./utils/gcsVision');
require('dotenv').config();
const { loadConfig } = require('./utils/config');
const { buildPrompt } = require('./utils/prompt');
const { normalizeSubfolder } = require('./utils/subfolder');
const { hashText, appendJSONL } = require('./utils/dryrun');
const { buildTargetInventoryText } = require('./utils/inventory');

const streamPipeline = promisify(pipeline);

// Laufweite Dedup-Map über OCR-Text-Hash
const seenByTranscript = new Map(); // hash -> { id, name, planned }

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

function ensureDateInFilename(filename, dateISO) {
  if (!dateISO) return filename;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  if (/\d{4}-\d{2}-\d{2}/.test(base)) return filename; // already has full date
  return `${base}-${dateISO}${ext}`;
}

function enrichDateInFilename(name, detected) {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  if (/\b\d{4}(-\d{2}){0,2}\b/.test(base)) return name; // already has date component
  if (!detected) return name;
  if (/^\d{4}-\d{2}-\d{2}$/.test(detected)) return `${base}-${detected}${ext}`;
  if (/^\d{4}-\d{2}$/.test(detected))       return `${base}-${detected}${ext}`;
  if (/^\d{4}$/.test(detected))               return `${base}-${detected}${ext}`;
  return name;
}

function isDuplicateRun(hash) { return seenByTranscript.has(hash); }
function rememberRun(hash, info) { seenByTranscript.set(hash, info); }

function deriveYearForCategory(transcript, subfolder, fallbackYear) {
  const t = String(transcript || '');
  if (/steuern/i.test(subfolder)) {
    const m = t.match(/(steuerjahr|veranlagung|tax\s*year)[^\d]{0,10}(\d{4})/i);
    if (m && m[2]) return m[2];
  }
  return fallbackYear;
}

async function ensurePathIds(drive, rootId, year, subfolder) {
  const yearId = await ensureFolderExists(drive, rootId, String(year));
  const subId  = await ensureFolderExists(drive, yearId, subfolder);
  const scanId = await ensureFolderExists(drive, subId, 'Scan');
  const textId = await ensureFolderExists(drive, subId, 'Texttranskript');
  return { yearId, subId, scanId, textId };
}

async function checkEnsureExists(drive, rootId, year, subfolder) {
  const out = {};
  const yearId = await findFolderId(drive, rootId, String(year));
  out[`${year}`] = !!yearId;
  const subId = yearId ? await findFolderId(drive, yearId, subfolder) : null;
  out[`${year}/${subfolder}`] = !!subId;
  const scanId = subId ? await findFolderId(drive, subId, 'Scan') : null;
  const textId = subId ? await findFolderId(drive, subId, 'Texttranskript') : null;
  out[`${year}/${subfolder}/Scan`] = !!scanId;
  out[`${year}/${subfolder}/Texttranskript`] = !!textId;
  return out;
}

async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken = undefined;
  do {
    const onlyUnprocessed = process.env.LIST_ONLY_UNPROCESSED === '1';
    let q = `'${folderId}' in parents and trashed = false`;
    if (onlyUnprocessed) {
      q += " and (not appProperties has { key='ds_processed' and value='1' })";
    }
    const res = await drive.files.list({
      q,
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

async function proposeNameFromText(documentText, originalName, foldersContext, promptText) {
  const client = new OpenAI.OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });
  const model = process.env.OPENAI_MODEL || 'gpt-4.1';
  const sys = `Du bist ein präziser Dokumentenanalyst und Dateibenenner. Antworte ausschließlich mit einem JSON-Objekt der Form {"new_filename":"...","target_folder":"..."}. Verwende niemals den Namen des Benutzers im Dateinamen.`;
  const rules = `Regeln:\n- Behalte die Dateiendung des Originals bei.\n- new_filename: nur [a-zA-Z0-9-_.], Leerzeichen zu '-',\n  beschreibe möglichst aussagekräftig (Dokumenttyp, Absender, Datum, Kennzeichen).\n- target_folder: nutze existierende Ordner falls passend, sonst neuen prägnanten Ordnernamen vorschlagen.\n- Keine Zusatztexte, kein Markdown, nur JSON.`;
  const content = [
    { type: 'input_text', text: sys },
    { type: 'input_text', text: promptText },
    { type: 'input_text', text: rules },
    { type: 'input_text', text: `Original filename: ${originalName}` },
    { type: 'input_text', text: `Aktuelle Ordner & Dateien:\n${foldersContext}` },
    { type: 'input_text', text: `Dokumenttext (OCR, ggf. gekürzt):\n${(documentText||'').slice(0, 12000)}` },
  ];
  const resp = await client.responses.create({ model, input: [ { role: 'user', content } ] });
  const text = resp?.output?.[0]?.content?.[0]?.text || resp?.output_text || '';
  return parseJsonResponse(text);
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
  const cfg = loadConfig();
  let promptText = loadPrompt();
  promptText = buildPrompt(promptText, {
    allowedSubfolders: cfg.allowed_subfolders,
    allowNewSubfolders: cfg.allow_new_subfolders,
    knownInstitutions: (cfg.prompt_overrides && cfg.prompt_overrides.company_terms) || [],
    disallowedTerms: (cfg.prompt_overrides && cfg.prompt_overrides.disallowed_terms) || []
  });

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
  const foldersContext = await buildTargetInventoryText(
    drive,
    TARGET_ROOT_FOLDER_ID,
    cfg,
    { depth: 3, recentYears: 3, maxFoldersPerLevel: 12, maxFilesPerFolder: 12, includeNonYearTop: true }
  );

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
      if (mime === 'application/pdf') {
        if (!process.env.GCS_BUCKET) {
          throw new Error('GCS_BUCKET ist nicht konfiguriert; PDF-OCR ist deaktiviert');
        }
        const res = await gcsVision.ocrPdfViaGCS(localPath, { bucket: process.env.GCS_BUCKET, prefix: process.env.GCS_PREFIX });
        const ocrText = res.text || '';

        // Duplicate-Detection vor LLM (spart Kosten)
        const txHash = hashText(ocrText);
        if (txHash && isDuplicateRun(txHash)) {
          const cfgDup = (cfg.duplicates || {});
          const policy = (cfgDup.policy || 'skip');
          const duplicateOf = seenByTranscript.get(txHash);

          if (DRY_RUN) {
            console.log(`\nDUPLICATE erkannt: "${file.name}" ~ "${duplicateOf.name}" [hash=${txHash.slice(0,8)}]`);
            if (process.env.DRY_RUN_OUTPUT) {
              await appendJSONL(process.env.DRY_RUN_OUTPUT, {
                file: { id: file.id, name: file.name, mime },
                duplicate_of: duplicateOf,
                duplicate_policy: policy
              });
            }
            // Cleanup GCS Artefakte des aktuellen Jobs
            try {
              const outPrefix = (res.outputPrefix || '').replace(/^gs:\/\/[a-z0-9\-]+\//i, '');
              if (res.bucket && outPrefix) await gcsVision.deleteGcsPrefix(res.bucket, outPrefix);
              if (res.bucket && res.inputObject) await gcsVision.deleteGcsObject(res.bucket, res.inputObject);
            } catch {}
            summary.processed += 1;
            summary.details.push({ file: file.name, duplicate_of: duplicateOf.id });
            continue;
          }

          if (policy === 'skip') {
            try {
              const outPrefix = (res.outputPrefix || '').replace(/^gs:\/\/[a-z0-9\-]+\//i, '');
              if (res.bucket && outPrefix) await gcsVision.deleteGcsPrefix(res.bucket, outPrefix);
              if (res.bucket && res.inputObject) await gcsVision.deleteGcsObject(res.bucket, res.inputObject);
            } catch {}
            console.log(`✔ Skip (Duplicate) "${file.name}" ~ "${duplicateOf.name}"`);
            summary.processed += 1;
            continue;
          }

          // Policy move → Duplikate
          const isoDup = (pdfNaming.extractMetadataFromText ? pdfNaming.extractMetadataFromText(ocrText).dateISO : null) || null;
          const dupYear0 = isoDup ? isoDup.slice(0,4) : String(new Date().getFullYear());
          const dupYear = deriveYearForCategory(ocrText, cfgDup.subfolder_name || 'Duplikate', dupYear0);
          const dupSub = cfgDup.subfolder_name || 'Duplikate';
          const { scanId, textId } = await ensurePathIds(drive, TARGET_ROOT_FOLDER_ID, dupYear, dupSub);
          const short = txHash.slice(0,8);
          const baseOrig = sanitizeFilenameBase(path.basename(file.name, path.extname(file.name)));
          const newDupName = `${baseOrig}-${(cfgDup.rename_suffix || 'dup')}-${short}${path.extname(file.name)}`;
          const dupTxt = `${path.basename(newDupName, path.extname(newDupName))}.txt`;
          await drive.files.create({
            requestBody: { name: dupTxt, parents: [textId] },
            media: { mimeType: 'text/plain', body: Buffer.from(ocrText, 'utf-8') },
            fields: 'id,name'
          });
          await renameAndMove(drive, file, newDupName, scanId, SOURCE_FOLDER_ID);
          try {
            const outPrefix = (res.outputPrefix || '').replace(/^gs:\/\/[a-z0-9\-]+\//i, '');
            if (res.bucket && outPrefix) await gcsVision.deleteGcsPrefix(res.bucket, outPrefix);
            if (res.bucket && res.inputObject) await gcsVision.deleteGcsObject(res.bucket, res.inputObject);
          } catch {}
          console.log(`✔ Duplicate verschoben nach "${dupYear}/${dupSub}/Scan/${newDupName}"`);
          summary.processed += 1; summary.moved += 1;
          continue;
        }
        // Kein Duplicate → merken
        if (txHash) rememberRun(txHash, { id: file.id, name: file.name });
        const t0 = Date.now();
        const proposal = await proposeNameFromText(ocrText, file.name, foldersContext, promptText);
        const llmLatencyMs = Date.now() - t0;
        const llmModel = process.env.OPENAI_MODEL || 'gpt-4.1';
        newFilename = proposal.new_filename || file.name;
        const ext = path.extname(file.name);
        if (!path.extname(newFilename)) newFilename = `${newFilename}${ext}`;
        const base = sanitizeFilenameBase(path.basename(newFilename, path.extname(newFilename)));
        newFilename = `${base}${path.extname(newFilename)}`;
        const proposedSub = proposal.subfolder || proposal.target_folder || 'Sonstiges';
        const subfolder = normalizeSubfolder(proposedSub, cfg);
        const meta = (pdfNaming.extractMetadataFromText ? pdfNaming.extractMetadataFromText(ocrText) : null) || {};
        const iso = meta.dateISO || null;
        const year0 = (proposal.year && String(proposal.year)) || (iso ? iso.slice(0,4) : String(new Date().getFullYear()));
        const year = deriveYearForCategory(ocrText, subfolder, year0);
        // Enrich filename with date: prefer full ISO; for Steuern use year if only that is known
        const detectedForName = iso || (/steuern/i.test(subfolder) ? year : null);
        newFilename = enrichDateInFilename(newFilename, detectedForName);
        const transcriptName = `${path.basename(newFilename, path.extname(newFilename))}.txt`;

        const planEnsure = [`${year}`, `${year}/${subfolder}`, `${year}/${subfolder}/Scan`, `${year}/${subfolder}/Texttranskript`];
        if (DRY_RUN) {
          const exists = await checkEnsureExists(drive, TARGET_ROOT_FOLDER_ID, year, subfolder);
          console.log(`\nPLAN für "${file.name}":`);
          console.log(`  ensure: ${JSON.stringify(planEnsure)}`);
          console.log(`  wouldMove: ${year}/${subfolder}/Scan/${newFilename}`);
          console.log(`  wouldUploadTxt: ${year}/${subfolder}/Texttranskript/${transcriptName}`);
          console.log(`  exists: ${JSON.stringify(exists)}`);
          if (process.env.DRY_RUN_OUTPUT) {
            const sha = hashText(ocrText);
            await appendJSONL(process.env.DRY_RUN_OUTPUT, {
              file: { id: file.id, name: file.name, mime },
              transcript: { chars: ocrText.length, sha256: sha },
              proposal: { ...proposal, subfolder, year, source: 'llm' },
              plan: { ensure: planEnsure, wouldMove: `${year}/${subfolder}/Scan/${newFilename}`, wouldUploadTxt: `${year}/${subfolder}/Texttranskript/${transcriptName}` },
              exists,
              llm: { model: llmModel, latency_ms: llmLatencyMs },
              ocr_source: res ? 'gcs-ocr' : 'pdf-parse',
              gcs: res ? { inputObject: res.inputObject, outputPrefix: res.outputPrefix } : undefined
            });
          }
          if (res) {
            try {
              const outPrefix = (res.outputPrefix || '').replace(/^gs:\/\/[a-z0-9\-]+\//i, '');
              if (res.bucket && outPrefix) await gcsVision.deleteGcsPrefix(res.bucket, outPrefix);
              if (res.bucket && res.inputObject) await gcsVision.deleteGcsObject(res.bucket, res.inputObject);
            } catch {}
          }
          summary.processed += 1;
          summary.details.push({ file: file.name, planned: `${year}/${subfolder}/Scan/${newFilename}` });
          continue;
        }

        const { scanId, textId } = await ensurePathIds(drive, TARGET_ROOT_FOLDER_ID, year, subfolder);
        await drive.files.create({
          requestBody: { name: transcriptName, parents: [textId] },
          media: { mimeType: 'text/plain', body: Buffer.from(ocrText, 'utf-8') },
          fields: 'id,name'
        });
        await renameAndMove(drive, file, newFilename, scanId, SOURCE_FOLDER_ID);
        try {
          await drive.files.update({
            fileId: file.id,
            requestBody: { appProperties: { ds_processed: '1', ds_year: String(year), ds_sub: subfolder, ds_newname: newFilename, ds_version: '2025-09-07' } },
            supportsAllDrives: true
          });
        } catch {}
        if (res) {
          try {
            const outPrefix = (res.outputPrefix || '').replace(/^gs:\/\/[a-z0-9\-]+\//i, '');
            if (res.bucket && outPrefix) await gcsVision.deleteGcsPrefix(res.bucket, outPrefix);
            if (res.bucket && res.inputObject) await gcsVision.deleteGcsObject(res.bucket, res.inputObject);
          } catch {}
        }
      } else {
        const t0 = Date.now();
        const analysis = await analyzeWithOpenAI(localPath, file.name, promptText);
        const llmLatencyMs = Date.now() - t0;
        const llmModel = 'gpt-4o-mini';
        const parsed = parseJsonResponse(analysis.raw);
        newFilename = parsed.new_filename || file.name;
        const ext = path.extname(file.name);
        if (!path.extname(newFilename)) {
          newFilename = `${newFilename}${ext}`;
        }
        const base = sanitizeFilenameBase(path.basename(newFilename, path.extname(newFilename)));
        newFilename = `${base}${path.extname(newFilename)}`;
        const proposedSub = parsed.subfolder || parsed.target_folder || 'Sonstiges';
        const subfolder = normalizeSubfolder(proposedSub, cfg);
        const year = String(new Date().getFullYear());
        const planEnsure = [`${year}`, `${year}/${subfolder}`, `${year}/${subfolder}/Scan`, `${year}/${subfolder}/Texttranskript`];
        const transcriptName = `${path.basename(newFilename, path.extname(newFilename))}.txt`;
        if (DRY_RUN) {
          const exists = await checkEnsureExists(drive, TARGET_ROOT_FOLDER_ID, year, subfolder);
          console.log(`\nPLAN für "${file.name}":`);
          console.log(`  ensure: ${JSON.stringify(planEnsure)}`);
          console.log(`  wouldMove: ${year}/${subfolder}/Scan/${newFilename}`);
          console.log(`  wouldUploadTxt: ${year}/${subfolder}/Texttranskript/${transcriptName}`);
          console.log(`  exists: ${JSON.stringify(exists)}`);
          if (process.env.DRY_RUN_OUTPUT) {
            await appendJSONL(process.env.DRY_RUN_OUTPUT, {
              file: { id: file.id, name: file.name, mime },
              proposal: { ...parsed, subfolder, year, source: 'llm' },
              plan: { ensure: planEnsure, wouldMove: `${year}/${subfolder}/Scan/${newFilename}`, wouldUploadTxt: `${year}/${subfolder}/Texttranskript/${transcriptName}` },
              exists,
              llm: { model: llmModel, latency_ms: llmLatencyMs }
            });
          }
          summary.processed += 1;
          summary.details.push({ file: file.name, planned: `${year}/${subfolder}/Scan/${newFilename}` });
          continue;
        }
        const { scanId, textId } = await ensurePathIds(drive, TARGET_ROOT_FOLDER_ID, year, subfolder);
        await drive.files.create({
          requestBody: { name: transcriptName, parents: [textId] },
          media: { mimeType: 'text/plain', body: Buffer.from('', 'utf-8') },
          fields: 'id,name'
        });
        await renameAndMove(drive, file, newFilename, scanId, SOURCE_FOLDER_ID);
        try {
          await drive.files.update({
            fileId: file.id,
            requestBody: { appProperties: { ds_processed: '1', ds_year: String(year), ds_sub: subfolder, ds_newname: newFilename, ds_version: '2025-09-07' } },
            supportsAllDrives: true
          });
        } catch {}
      }
      console.log(`✔ Umbenannt in "${newFilename}" und in Jahresstruktur (Scan/Texttranskript) verschoben`);
      summary.processed += 1;
      summary.moved += 1;
      summary.details.push({ file: file.name, to: `Jahresstruktur/${newFilename}` });
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

  if (process.env.CLEAR_GCS_PREFIX_ON_EXIT === '1') {
    const bucket = process.env.GCS_BUCKET;
    const prefix = (process.env.GCS_PREFIX || '').trim();
    if (bucket && prefix && prefix.length >= 10) {
      console.log(`[GCS] Global cleanup enabled: gs://${bucket}/${prefix}/`);
      try { await gcsVision.deleteGcsPrefix(bucket, `${prefix}/`); }
      catch (e) { console.warn('[GCS] Global cleanup failed:', e.message); }
    } else {
      console.warn('[GCS] Skip global cleanup: unsafe or missing prefix/bucket');
    }
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Unerwarteter Fehler:', err);
    process.exit(1);
  });
}
