const path = require('path');
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const vision = require('@google-cloud/vision').v1;

function requiredEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getStorage() {
  // Auth via GOOGLE_APPLICATION_CREDENTIALS
  return new Storage();
}

function getVisionClient() {
  return new vision.ImageAnnotatorClient();
}

async function uploadToGCS(localPath, bucketName, destPath) {
  const storage = getStorage();
  const bucket = storage.bucket(bucketName);
  await bucket.upload(localPath, { destination: destPath, resumable: true });
  return `gs://${bucketName}/${destPath}`;
}

async function listGcsJsonUris(bucketName, prefix) {
  const storage = getStorage();
  const [files] = await storage.bucket(bucketName).getFiles({ prefix });
  return files.filter(f => f.name.toLowerCase().endsWith('.json')).map(f => `gs://${bucketName}/${f.name}`);
}

async function downloadGcsFile(bucketName, objectPath) {
  const storage = getStorage();
  const [contents] = await storage.bucket(bucketName).file(objectPath).download();
  return contents.toString('utf-8');
}

function ensureGsPrefix(uri) {
  return uri.endsWith('/') ? uri : uri + '/';
}

async function ocrPdfViaGCS(localPdfPath, opts = {}) {
  const bucket = opts.bucket || requiredEnv('GCS_BUCKET');
  const prefix = (opts.prefix || process.env.GCS_PREFIX || 'drivesorter').replace(/\/*$/, '');
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const inputObject = `${prefix}/input/${jobId}-${path.basename(localPdfPath)}`;
  const outputPrefix = `${prefix}/output/${jobId}/`;

  const inputGcsUri = await uploadToGCS(localPdfPath, bucket, inputObject);

  const client = getVisionClient();
  const inputConfig = {
    mimeType: 'application/pdf',
    gcsSource: { uri: inputGcsUri },
  };
  const outputConfig = {
    gcsDestination: { uri: `gs://${bucket}/${outputPrefix}` },
    batchSize: Number(process.env.GCS_VISION_BATCH_SIZE || 5),
  };
  const features = [{ type: 'DOCUMENT_TEXT_DETECTION' }];
  const request = { requests: [{ features, inputConfig, outputConfig }] };

  const [operation] = await client.asyncBatchAnnotateFiles(request);
  await operation.promise();

  const jsonUris = await listGcsJsonUris(bucket, outputPrefix);
  let fullText = '';
  for (const uri of jsonUris) {
    const objectPath = uri.replace(`gs://${bucket}/`, '');
    const text = await downloadGcsFile(bucket, objectPath);
    try {
      const data = JSON.parse(text);
      const responses = data.responses || [];
      for (const r of responses) {
        if (r.fullTextAnnotation && r.fullTextAnnotation.text) {
          fullText += r.fullTextAnnotation.text + '\n';
        }
      }
    } catch {}
  }

  return { text: fullText.trim(), inputGcsUri, inputObject, bucket, outputPrefix: `gs://${bucket}/${outputPrefix}` };
}

module.exports = {
  ocrPdfViaGCS,
};

// Cleanup utilities
async function deleteGcsObject(bucketName, objectPath) {
  const storage = getStorage();
  try { await storage.bucket(bucketName).file(objectPath).delete({ ignoreNotFound: true }); } catch {}
}

async function deleteGcsPrefix(bucketName, prefix) {
  const storage = getStorage();
  try { await storage.bucket(bucketName).deleteFiles({ prefix, force: true }); } catch {}
}

module.exports.deleteGcsObject = deleteGcsObject;
module.exports.deleteGcsPrefix = deleteGcsPrefix;

// --- NEW: Image OCR via GCS ---
async function ocrImageViaGCS(localImagePath, opts = {}) {
  const bucket = opts.bucket || requiredEnv('GCS_BUCKET');
  const prefix = (opts.prefix || process.env.GCS_PREFIX || 'drivesorter').replace(/\/*$/, '');
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const inputObject = `${prefix}/input/${jobId}-${path.basename(localImagePath)}`;
  await uploadToGCS(localImagePath, bucket, inputObject);

  const client = getVisionClient();
  const [result] = await client.documentTextDetection({ image: { source: { imageUri: `gs://${bucket}/${inputObject}` } } });
  const text = (result && result.fullTextAnnotation && result.fullTextAnnotation.text) ? result.fullTextAnnotation.text : '';
  return { text: (text || '').trim(), inputObject, bucket };
}

module.exports.ocrImageViaGCS = ocrImageViaGCS;
