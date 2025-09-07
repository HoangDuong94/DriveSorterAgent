const path = require('path');
const { Readable } = require('stream');

function buildMeta({ file, newFilename, year, subfolder, transcript, metaFromText, ocrSource, llm }) {
  const base = path.basename(newFilename, path.extname(newFilename));
  const detectedDate = metaFromText?.dateISO || null;

  return {
    file_id: file.id,
    original_name: file.name,
    new_filename: newFilename,
    year_folder: String(year),
    subfolder,
    paths: {
      scan: `${year}/${subfolder}/Scan/${newFilename}`,
      transcript: `${year}/${subfolder}/Texttranskript/${base}.txt`
    },
    document_date: detectedDate || null,
    category: subfolder,
    sender: metaFromText?.sender || null,
    invoice_number: metaFromText?.invoiceNumber || null,
    sha256: transcript?.sha256 || null,
    ocr_source: ocrSource || null,
    llm_model: llm?.model || null,
    llm_latency_ms: llm?.latency_ms || null,
    processed_at: new Date().toISOString()
  };
}

async function writeMeta(drive, textFolderId, nameBase, metaObj) {
  const body = Readable.from([JSON.stringify(metaObj, null, 2)]);
  await drive.files.create({
    requestBody: { name: `${nameBase}.meta.json`, parents: [textFolderId] },
    media: { mimeType: 'application/json', body },
    fields: 'id,name'
  });
}

async function ensureRegistryFolder(drive, rootId, folderName) {
  const res = await drive.files.list({
    q: `'${rootId}' in parents and trashed = false and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id,name)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    pageSize: 1
  });
  if (res.data.files && res.data.files.length) return res.data.files[0].id;
  const createRes = await drive.files.create({
    requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [rootId] },
    fields: 'id,name',
    supportsAllDrives: true
  });
  return createRes.data.id;
}

async function writeRegistryEntry(drive, rootId, folderName, metaObj) {
  const regId = await ensureRegistryFolder(drive, rootId, folderName);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${ts}-${metaObj.file_id}`;
  const body = Readable.from([JSON.stringify(metaObj) + '\n']);
  await drive.files.create({
    requestBody: { name: `${base}.jsonl`, parents: [regId] },
    media: { mimeType: 'application/json', body },
    fields: 'id,name'
  });
}

module.exports = { buildMeta, writeMeta, writeRegistryEntry, ensureRegistryFolder };
