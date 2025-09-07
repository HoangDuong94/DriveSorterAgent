# GCS Vision – OCR für PDFs & Bilder

## Status Quo
- PDFs: `ocrPdfViaGCS(localPdfPath, { bucket, prefix })` – vorhanden
- Bilder: fehlt → jetzt ergänzen

## Neu: `ocrImageViaGCS`

Ziel: Ein einzelnes Bild (jpg/png/webp) nach GCS laden und mit Vision `documentTextDetection` reinen Text extrahieren. Rückgabe analog zur PDF‑OCR für einheitliches Cleanup.

### Signatur

```js
async function ocrImageViaGCS(localImagePath, opts = {}) {
  // returns { text, bucket, inputObject /* no outputPrefix needed for images */ }
}
```

### Umsetzung (Beispiel)

```js
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const vision = require('@google-cloud/vision').v1;

async function ocrImageViaGCS(localImagePath, opts = {}) {
  const bucket = opts.bucket || requiredEnv('GCS_BUCKET');
  const prefix = (opts.prefix || process.env.GCS_PREFIX || 'drivesorter').replace(/\/*$/, '');
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const inputObject = `${prefix}/input/${jobId}-${path.basename(localImagePath)}`;

  // Upload
  await uploadToGCS(localImagePath, bucket, inputObject);
  const gcsUri = `gs://${bucket}/${inputObject}`;

  const client = new vision.ImageAnnotatorClient();
  const [result] = await client.documentTextDetection({ image: { source: { imageUri: gcsUri } } });
  const text = (result && result.fullTextAnnotation && result.fullTextAnnotation.text) ? result.fullTextAnnotation.text : '';

  return { text: (text || '').trim(), bucket, inputObject };
}
```

Hinweis Cleanup: Für Bilder gibt es kein `outputPrefix` – lösche nach Verarbeitung lediglich `inputObject`. PDFs nutzen weiterhin `outputPrefix` (JSON‑Shards) und `inputObject`.

## Wrapper in `index.js`

```js
async function ocrViaGcsAuto(localPath, originalName) {
  const mime = getMimeFromFilename(originalName);
  if (mime === 'application/pdf') {
    return { ...(await gcsVision.ocrPdfViaGCS(localPath)) , kind: 'pdf' };
  }
  if (mime.startsWith('image/')) {
    return { ...(await gcsVision.ocrImageViaGCS(localPath)), kind: 'image' };
  }
  // Fallback: versuche nichts zu OCRen
  return { text: '', kind: 'other' };
}
```

