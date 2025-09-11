
# Drive Sorter – Backend (Option A, Service‑Account & PWA/API)

**Version:** v1.1 (2025‑09‑10)
**Scope:** API + minimaler Refactor über dem bestehenden Node‑Projekt, Deployment auf Cloud Run, Auth via `X-Access-Key`, Service‑Account greift **nur** auf **durch Freunde freigegebene Ordner** zu.
**Projekt‑ID:** `drive-sorter-agent-837493`
**Region:** `europe-west6` (Zürich)
**Bucket:** `drive-sorter-agent-pdf-inbox-837493`
**Prefix:** *leer* (siehe Hinweis unter *Code‑Patch: GCS Prefix*)

---

## 0) Ziele

1. **API bereitstellen** (Cloud Run) mit Endpunkten für Health, Onboarding (Share‑Check & Config speichern), Dry‑Run, Run sowie Status/Logs.
2. **Auth** über **Shared Secret Header** `X-Access-Key` (Keys in Secret Manager).
3. **Drive‑Zugriff** über **Service‑Account**, dem Freund\:innen **genau zwei Ordner** (Source & Target Root) **als Bearbeiter** freigeben.
4. **OCR** via **Vision asyncBatchAnnotateFiles** in **GCS** (Lifecycle: *Delete after 1 day*).
5. Minimal‑invasive Änderungen am bestehenden Code: **ADC‑Fallback**, Parametrisierung, Kapselung in `runSorter(opts)`.

---

## 1) Ordnerstruktur (neu)

```text
.
├─ api/
│  ├─ server.js              # Fastify/Express Bootstrap (empfohlen: Fastify)
│  └─ routes/
│     ├─ health.js
│     ├─ onboard.js          # /api/onboard/share-check + /api/onboard/save-config
│     └─ runs.js             # /api/dry-run, /api/run, /api/runs/:id
├─ services/
│  ├─ driveSorter.js         # Extrakt aus src/index.js → runSorter(opts)
│  ├─ auth.js                # X-Access-Key validieren (Secret Manager, Cache)
│  ├─ configStore.js         # User-Configs in GCS laden/speichern
│  └─ runsStore.js           # Run-Status/Logs in GCS
├─ lib/
│  ├─ google.js              # initDrive() via ADC; Storage, Vision Clients
│  └─ id.js                  # Drive-ID/URL-Parser
├─ src/                      # (bestehender Code, minimal angepasst)
├─ Dockerfile
└─ docs/backend-spec-option-a.md (dieses Dokument)
```

**Neue Dependencies (Vorschlag):**

* `fastify`, `pino` (Logging), `lru-cache`, `uuid`, `@google-cloud/secret-manager`

```json
// package.json (Ausschnitt)
"dependencies": {
  "@google-cloud/secret-manager": "^5.0.0",
  "fastify": "^4.28.0",
  "lru-cache": "^10.3.0",
  "pino": "^9.3.0",
  "uuid": "^9.0.1",
  "@google-cloud/storage": "^7.17.0",
  "@google-cloud/vision": "^5.3.3",
  "dotenv": "^17.2.2",
  "googleapis": "^159.0.0",
  "openai": "^5.19.1"
}
```

---

## 2) Environment & Secrets

**Env‑Variablen (Cloud Run):**

* `GCP_PROJECT_ID=drive-sorter-agent-837493`
* `REGION=europe-west6`
* `GCS_BUCKET=drive-sorter-agent-pdf-inbox-837493`
* `GCS_PREFIX=` *(leer; siehe Patch)*
* `DS_VERSION=2025-09-10`
* `ACCESS_KEYS_SOURCE=secret`
* `ACCESS_KEYS_SECRET_NAME=drivesorter-access-keys`
* `OPENAI_MODEL=gpt-4.1`
* `OPENAI_API_KEY` → **über Secret Manager** injiziert

**Secrets (Secret Manager):**

* `openai-api-key` → Bindung als Env `OPENAI_API_KEY`
* `drivesorter-access-keys` → Inhalt: eine Zeile pro gültigem Key

---

## 3) Code‑Patches (gezielt & klein)

### 3.1 ADC‑Fallback in `initDrive()` (Cloud Run, **ohne** Keyfile)

> *Ziel*: Wenn **weder** OAuth‑Client noch `GOOGLE_APPLICATION_CREDENTIALS` gesetzt sind, **ADC** nutzen (Metadaten‑Server der Cloud‑Run‑SA).

```js
// lib/google.js
const { google } = require('googleapis');

async function initDriveUsingADC() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const client = await auth.getClient();
  return google.drive({ version: 'v3', auth: client });
}

module.exports = { initDriveUsingADC };
```

**Integration in bestehende Logik** (ersetze den Fallback‑Teil in `src/index.js:initDrive`):

```js
// src/index.js (nur der Fallback-Teil)
async function initDrive(opts = {}) {
  const cid = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const csec = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  // ... (OAuth-Teil unverändert)

  const keyFile = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (keyFile) {
    // ... (Service Account JSON wie gehabt)
    // (unverändert)
  }

  // >>> Neu: ADC-Fallback (Cloud Run)
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const client = await auth.getClient();
  return google.drive({ version: 'v3', auth: client });
}
```

### 3.2 **GCS Prefix „leer“** korrekt unterstützen

Dein `gcsVision.js` erzwingt derzeit einen Default `'drivesorter'`, wenn `GCS_PREFIX` leer ist. Für **explizit leeren Prefix**:

```js
// src/utils/gcsVision.js (Patch oben bei Prefix-Bildung)
function resolvePrefix(opts) {
  if (Object.prototype.hasOwnProperty.call(opts, 'prefix')) return opts.prefix || '';
  if (Object.prototype.hasOwnProperty.call(process.env, 'GCS_PREFIX')) return process.env.GCS_PREFIX || '';
  return 'drivesorter'; // echter Fallback nur, wenn nirgends definiert
}

async function ocrPdfViaGCS(localPdfPath, opts = {}) {
  const bucket = opts.bucket || requiredEnv('GCS_BUCKET');
  const prefixRaw = resolvePrefix(opts);
  const prefix = prefixRaw.replace(/\/*$/, ''); // trailing slash ab
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const inputObject = `${prefix ? prefix + '/' : ''}input/${jobId}-${path.basename(localPdfPath)}`;
  const outputPrefix = `${prefix ? prefix + '/' : ''}output/${jobId}/`;
  // ...
}
```

Gleiches Schema bei `ocrImageViaGCS`.

---

## 4) Hilfs‑Libs

### 4.1 Secret‑Access & `X-Access-Key`‑Auth

```js
// services/auth.js
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const LRU = require('lru-cache');

const cache = new LRU({ max: 1, ttl: 5 * 60 * 1000 }); // 5 Min
const SECRET_NAME = process.env.ACCESS_KEYS_SECRET_NAME || 'drivesorter-access-keys';

async function loadKeysFromSecret() {
  const cached = cache.get('keys');
  if (cached) return cached;
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${process.env.GCP_PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest`,
  });
  const content = version.payload.data.toString('utf8');
  const keys = new Set(content.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  cache.set('keys', keys);
  return keys;
}

async function requireAccessKey(req, res, next) {
  try {
    const provided = req.headers['x-access-key'];
    if (!provided) return res.status(401).send({ error: { code: 401, message: 'Unauthorized', details: 'missing-access-key' } });
    const keys = await loadKeysFromSecret();
    if (!keys.has(provided)) return res.status(403).send({ error: { code: 403, message: 'Forbidden', details: 'invalid-access-key' } });
    next();
  } catch (e) {
    res.status(500).send({ error: { code: 500, message: 'Secret error', details: e.message } });
  }
}

module.exports = { requireAccessKey };
```

> Für Fastify als Plugin anpassen (`onRequest`‑Hook); oben ist Express‑Style. In der API unten zeige ich Fastify.

### 4.2 Drive‑ID aus URL extrahieren

```js
// lib/id.js
function extractId(idOrUrl) {
  if (!idOrUrl) return null;
  const s = String(idOrUrl).trim();
  if (/^[A-Za-z0-9_-]{15,}$/.test(s)) return s;
  // URL-Varianten: /folders/<id>, /file/d/<id>, open?id=<id>
  const m1 = s.match(/\/folders\/([A-Za-z0-9_-]{15,})/);
  if (m1) return m1[1];
  const m2 = s.match(/\/file\/d\/([A-Za-z0-9_-]{15,})/);
  if (m2) return m2[1];
  const m3 = s.match(/[?&]id=([A-Za-z0-9_-]{15,})/);
  if (m3) return m3[1];
  return null;
}
module.exports = { extractId };
```

---

## 5) API‑Server

### 5.1 Bootstrap (Fastify)

```js
// api/server.js
const fastify = require('fastify')({ logger: true });
const { requireAccessKey } = require('../services/auth');

fastify.register(require('@fastify/formbody')); // falls nötig
fastify.addHook('onRequest', async (req, reply) => {
  // Health/Version ohne Auth
  if (['/healthz','/readyz','/version'].includes(req.url)) return;
  // Access-Key prüfen
  const key = req.headers['x-access-key'];
  if (!key) return reply.code(401).send({ error: { code: 401, message: 'Unauthorized' } });
  // sehr simple inline-Variante: für Prod-Use siehe services/auth.js
  const { loadKeysFromSecret } = require('../services/auth');
  const keys = await loadKeysFromSecret();
  if (!keys.has(String(key))) return reply.code(403).send({ error: { code: 403, message: 'Forbidden' } });
});

fastify.get('/healthz', async () => ({ ok: true }));
fastify.get('/version', async () => ({ version: process.env.DS_VERSION || 'dev', region: process.env.REGION }));

fastify.register(require('./routes/health'));
fastify.register(require('./routes/onboard'), { prefix: '/api/onboard' });
fastify.register(require('./routes/runs'), { prefix: '/api' });

const port = process.env.PORT || 8080;
fastify.listen({ port, host: '0.0.0.0' })
  .then(addr => fastify.log.info(`API listening on ${addr}`))
  .catch(err => { fastify.log.error(err); process.exit(1); });
```

### 5.2 Health/Ready

```js
// api/routes/health.js
module.exports = async function (app) {
  app.get('/readyz', async (req, reply) => {
    // Quick checks: Secret, GCS, Vision
    try {
      const { Storage } = require('@google-cloud/storage');
      const storage = new Storage();
      const [buckets] = await storage.getBuckets({ maxResults: 1 });
      return reply.send({ ok: true, components: { storage: true, buckets: buckets.length >= 0 } });
    } catch (e) {
      return reply.code(500).send({ ok: false, error: e.message });
    }
  });
};
```

### 5.3 Onboarding (Share‑Check & Save‑Config)

```js
// api/routes/onboard.js
const { extractId } = require('../../lib/id');
const { initDriveUsingADC } = require('../../lib/google');
const { saveUserConfig } = require('../../services/configStore');

module.exports = async function (app) {
  app.post('/share-check', async (req, reply) => {
    const { sourceFolder, targetRoot } = req.body || {};
    const srcId = extractId(sourceFolder);
    const trgId = extractId(targetRoot);
    if (!srcId || !trgId) return reply.code(422).send({ error: { code: 422, message: 'invalid-ids' } });

    const drive = await initDriveUsingADC();
    async function check(id) {
      try {
        const res = await drive.files.get({
          fileId: id,
          fields: 'id,name,mimeType,capabilities(canEdit,canAddChildren)',
          supportsAllDrives: true,
        });
        const f = res.data;
        return { id: f.id, name: f.name, access: (f.capabilities?.canEdit ? 'editor' : 'reader'), mimeType: f.mimeType };
      } catch (e) {
        if (e.code === 404) return { id, error: 'not-found' };
        if (e.code === 403) return { id, error: 'forbidden' };
        return { id, error: 'error', detail: e.message };
      }
    }

    const [src, trg] = await Promise.all([check(srcId), check(trgId)]);
    if (src.error || trg.error) return reply.code(403).send({ ok: false, source: src, target: trg });

    return reply.send({ ok: true, source: src, target: trg, hints: ['Service-Account benötigt Editor-Rechte (canEdit=true).'] });
  });

  app.post('/save-config', async (req, reply) => {
    const { email, sourceFolderId, targetRootFolderId } = req.body || {};
    if (!email || !sourceFolderId || !targetRootFolderId) {
      return reply.code(422).send({ error: { code: 422, message: 'missing-fields' } });
    }
    const ref = await saveUserConfig({ email, sourceFolderId, targetRootFolderId });
    return reply.send({ ok: true, configRef: ref });
  });
};
```

### 5.4 Runs (Dry‑Run, Run, Status)

```js
// api/routes/runs.js
const { startDryRun, startRun, getRunStatus } = require('../../services/runsStore');

module.exports = async function (app) {
  app.post('/dry-run', async (req, reply) => {
    const { email } = req.body || {};
    if (!email) return reply.code(422).send({ error: { code: 422, message: 'missing-email' } });
    const res = await startDryRun({ email });
    return reply.send(res);
  });

  app.post('/run', async (req, reply) => {
    const { email } = req.body || {};
    if (!email) return reply.code(422).send({ error: { code: 422, message: 'missing-email' } });
    const res = await startRun({ email });
    return reply.code(202).send(res);
  });

  app.get('/runs/:runId', async (req, reply) => {
    const st = await getRunStatus(req.params.runId);
    if (!st) return reply.code(404).send({ error: { code: 404, message: 'run-not-found' } });
    return reply.send(st);
  });
};
```

---

## 6) Services

### 6.1 User‑Config in GCS

```js
// services/configStore.js
const crypto = require('crypto');
const { Storage } = require('@google-cloud/storage');

const BUCKET = process.env.GCS_BUCKET;

function emailHash(email) {
  return crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex');
}

async function saveUserConfig({ email, sourceFolderId, targetRootFolderId }) {
  const storage = new Storage();
  const h = emailHash(email);
  const file = storage.bucket(BUCKET).file(`configs/${h}.json`);
  const cfg = {
    email, sourceFolderId, targetRootFolderId,
    gcsPrefix: `users/${h}`,
    settings: {
      allow_new_subfolders: false,
      duplicates: { policy: 'skip', rename_suffix: 'dup', subfolder_name: 'Duplikate' }
    },
    updatedAt: new Date().toISOString(),
  };
  await file.save(JSON.stringify(cfg, null, 2), { contentType: 'application/json' });
  return `gs://${BUCKET}/configs/${h}.json`;
}

async function loadUserConfig(email) {
  const storage = new Storage();
  const h = emailHash(email);
  const file = storage.bucket(BUCKET).file(`configs/${h}.json`);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buf] = await file.download();
  return JSON.parse(buf.toString('utf8'));
}

module.exports = { saveUserConfig, loadUserConfig, emailHash };
```

### 6.2 Run‑Orchestrierung & Status

```js
// services/runsStore.js
const { v4: uuidv4 } = require('uuid');
const { Storage } = require('@google-cloud/storage');
const { runSorter } = require('./driveSorter');
const { loadUserConfig } = require('./configStore');

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET;

async function writeStatus(runId, obj) {
  const file = storage.bucket(BUCKET).file(`runs/${runId}/status.json`);
  await file.save(JSON.stringify(obj), { contentType: 'application/json' });
}

async function appendLog(runId, entry) {
  const file = storage.bucket(BUCKET).file(`runs/${runId}/logs.ndjson`);
  await file.save(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { resumable: false, contentType: 'application/x-ndjson', preconditionOpts: { ifGenerationMatch: 0 } }).catch(async () => {
    // Falls existiert: append via compose Workaround (vereinfachen: hier ignorieren)
  });
}

async function startDryRun({ email }) {
  const cfg = await loadUserConfig(email);
  if (!cfg) return { ok: false, error: 'config-not-found' };

  const runId = `run_${new Date().toISOString()}_${uuidv4().slice(0,8)}`;
  const summary = await runSorter({
    sourceFolderId: cfg.sourceFolderId,
    targetRootFolderId: cfg.targetRootFolderId,
    dryRun: true,
    userEmail: email,
    gcsPrefix: cfg.gcsPrefix,
    onLog: (e) => appendLog(runId, { level: 'info', msg: e }),
    onProgress: (p) => writeStatus(runId, { ok: true, runId, state: 'running', progress: p }),
  });

  await writeStatus(runId, { ok: true, runId, state: 'succeeded', summary });
  return { ok: true, runId, summary, artifacts: [{ type: 'json', gcs: `gs://${BUCKET}/runs/${runId}/status.json` }] };
}

async function startRun({ email }) {
  const cfg = await loadUserConfig(email);
  if (!cfg) return { ok: false, error: 'config-not-found' };

  const runId = `run_${new Date().toISOString()}_${uuidv4().slice(0,8)}`;
  // Nicht blockierend: hier einfach "fire-and-forget" (vereinfachtes Muster)
  (async () => {
    try {
      await writeStatus(runId, { ok: true, runId, state: 'running' });
      const summary = await runSorter({
        sourceFolderId: cfg.sourceFolderId,
        targetRootFolderId: cfg.targetRootFolderId,
        dryRun: false,
        userEmail: email,
        gcsPrefix: cfg.gcsPrefix,
        onLog: (e) => appendLog(runId, { level: 'info', msg: e }),
        onProgress: (p) => writeStatus(runId, { ok: true, runId, state: 'running', progress: p }),
      });
      await writeStatus(runId, { ok: true, runId, state: 'succeeded', summary });
    } catch (e) {
      await writeStatus(runId, { ok: false, runId, state: 'failed', error: e.message });
    }
  })();

  return { ok: true, runId };
}

async function getRunStatus(runId) {
  const file = storage.bucket(BUCKET).file(`runs/${runId}/status.json`);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buf] = await file.download();
  return JSON.parse(buf.toString('utf8'));
}

module.exports = { startDryRun, startRun, getRunStatus };
```

### 6.3 Adapter um deinen bestehenden Code

```js
// services/driveSorter.js
// Ziel: src/index.js-Logik als Funktion nutzen, ohne CLI/argv, mit Callbacks

const path = require('path');
const { loadConfig } = require('../src/utils/config');
const { buildTargetInventoryText } = require('../src/utils/inventory');
const { initDriveUsingADC } = require('../lib/google');

// Tipp: Teile in src/index.js die Kernschritte in Funktionen aus und importiere hier.
// Für Demo: vereinfachter Wrapper
async function runSorter(opts) {
  const {
    sourceFolderId, targetRootFolderId, dryRun = true, userEmail = 'unknown',
    gcsPrefix = '', onLog = () => {}, onProgress = () => {}
  } = opts;

  const cfg = loadConfig();
  const drive = await initDriveUsingADC();

  onLog(`Start run (dryRun=${dryRun}) for ${userEmail}`);
  // Beispiel: Inventar (nur als Check)
  const inv = await buildTargetInventoryText(drive, targetRootFolderId, cfg, { depth: 2, recentYears: 2 });
  onLog(`Inventory preview:\n${inv.split('\n').slice(0,10).join('\n')}`);

  // >>> Hier: Statt main() aufzurufen, importiere und nutze die Einzelschritte aus src/index.js
  //     oder kapsle main() so, dass Parameter injiziert werden können.
  //     Für PoC: starte einen vereinfachten Dry-Run auf Basis vorhandener Utils.

  // Dummy-Progress (ersetzen durch echte Zahlen aus deinem Flow)
  onProgress({ processed: 0, moved: 0, errors: 0 });

  // --- HIER: Deinen vorhandenen Ablauf integrieren ---
  // 1) Files im Source auflisten
  // 2) OCR/LLM Pipelines (mit GCS_PREFIX=gcsPrefix) laufen lassen
  // 3) Bei dryRun JSONL/Plan schreiben, bei run: move & sidecars
  // 4) Progress laufend melden

  // Ergebnis-Objekt so wie deine CLI-Zusammenfassung
  const summary = {
    processed: 0, moved: 0, errors: 0,
    counts: { gcs_ocr: 0, gcs_ocr_image: 0, duplicates: 0 }
  };
  onLog('Run finished.');
  return summary;
}

module.exports = { runSorter };
```

> **Hinweis:** Für die echte Integration kannst du große Teile aus `src/index.js` 1:1 übernehmen und nur die I/O‑Pfade (IDs, Prefix, Dry‑Run) an Parametern festmachen. Die bestehenden Utils (OCR, Naming, Sidecar, Inventory) bleiben unverändert.

---

## 7) Dockerfile

```dockerfile
# Dockerfile
FROM node:18-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Health port for Cloud Run
ENV PORT=8080
EXPOSE 8080

CMD ["node", "api/server.js"]
```

---

## 8) Cloud Setup (CLI)

### 8.1 APIs aktivieren

```bash
gcloud config set project drive-sorter-agent-837493

gcloud services enable run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  vision.googleapis.com \
  drive.googleapis.com
```

### 8.2 Service Account & Rollen

```bash
gcloud iam service-accounts create drivesorter-runtime \
  --display-name="Drive Sorter Runtime"

# Rollen
gcloud projects add-iam-policy-binding drive-sorter-agent-837493 \
  --member="serviceAccount:drivesorter-runtime@drive-sorter-agent-837493.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud storage buckets add-iam-policy-binding gs://drive-sorter-agent-pdf-inbox-837493 \
  --member="serviceAccount:drivesorter-runtime@drive-sorter-agent-837493.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

### 8.3 Secret Manager

```bash
# OpenAI Key anlegen (falls noch nicht)
echo -n "$OPENAI_API_KEY" | gcloud secrets create openai-api-key --data-file=-
# Access Keys (eine Zeile pro Key)
printf "key_for_friend_A\nkey_for_friend_B\n" | gcloud secrets create drivesorter-access-keys --data-file=-
```

### 8.4 GCS Lifecycle (Delete nach 1 Tag)

`lifecycle.json`:

```json
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": 1 }
    }
  ]
}
```

```bash
gsutil lifecycle set lifecycle.json gs://drive-sorter-agent-pdf-inbox-837493
```

### 8.5 Deploy (Cloud Run, Source Build)

```bash
gcloud run deploy drivesorter-api \
  --source . \
  --region europe-west6 \
  --service-account drivesorter-runtime@drive-sorter-agent-837493.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars GCP_PROJECT_ID=drive-sorter-agent-837493,REGION=europe-west6,GCS_BUCKET=drive-sorter-agent-pdf-inbox-837493,GCS_PREFIX=,DS_VERSION=2025-09-10,ACCESS_KEYS_SOURCE=secret,ACCESS_KEYS_SECRET_NAME=drivesorter-access-keys,OPENAI_MODEL=gpt-4.1 \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest \
  --cpu=1 --memory=2Gi --concurrency=10 --min-instances=0 --timeout=900
```

> `--timeout=900` (=15 min) kann später auf bis zu **3600 s** erhöht werden.

---

## 9) API Beispiele (Requests/Responses)

**Share‑Check**

```bash
curl -s -X POST "$BASE/api/onboard/share-check" \
  -H "Content-Type: application/json" \
  -H "X-Access-Key: key_for_friend_A" \
  -d '{"sourceFolder":"https://drive.google.com/drive/folders/<SRC>","targetRoot":"<TRG_ID>"}'
```

**Response ok**

```json
{
  "ok": true,
  "source": {"id":"<SRC>","name":"Eingang","access":"editor","mimeType":"application/vnd.google-apps.folder"},
  "target": {"id":"<TRG>","name":"Ziel","access":"editor","mimeType":"application/vnd.google-apps.folder"},
  "hints": ["Service-Account benötigt Editor-Rechte (canEdit=true)."]
}
```

**Dry‑Run**

```bash
curl -s -X POST "$BASE/api/dry-run" \
  -H "Content-Type: application/json" \
  -H "X-Access-Key: key_for_friend_A" \
  -d '{"email":"friend@example.com"}'
```

**Response**

```json
{
  "ok": true,
  "runId": "run_2025-09-10T19:01:12.345Z_ab12cd34",
  "summary": { "processed": 42, "moved": 0, "errors": 0, "counts": { "duplicates": 3 } },
  "artifacts": [{ "type":"json", "gcs":"gs://drive-sorter-agent-pdf-inbox-837493/runs/run_.../status.json" }]
}
```

---

## 10) Akzeptanzkriterien

1. **Auth:** Requests ohne/falschen `X-Access-Key` → `401/403`.
2. **Share‑Check:**

   * Liefert `ok:true` nur, wenn **beide** Ordner existieren und `capabilities.canEdit=true`.
   * Ansonsten `403` mit `{ source/target: { error: ... } }`.
3. **Config:** `/save-config` legt JSON unter `gs://.../configs/<email-hash>.json` ab.
4. **Dry‑Run/Run:**

   * Dry‑Run erzeugt keine Moves, aber Plan/Logs.
   * Run verschiebt Dateien gemäß vorhandener Logik inkl. Sidecars/Registry.
5. **OCR‑Artefakte:** in GCS, Lifecycle löscht nach \~1 Tag.
6. **Timeouts:** Standardläufe bleiben unter 60 Min; Status korrekt aktualisiert.
7. **Logging:** `runs/<runId>/status.json` + `logs.ndjson` vorhanden.

---

## 11) Onboarding‑Hinweis für Freund\:innen

1. Hoang sendet **Service‑Account‑E‑Mail** (z. B. `drivesorter-runtime@drive-sorter-agent-837493.iam.gserviceaccount.com`).
2. In Drive **zwei Ordner** (Eingang & Ziel‑Root) **mit dieser E‑Mail als „Bearbeiter“ teilen**.
3. PWA öffnen → `share-check` → `save-config` → `dry-run` → `run`.
4. Optional: PWA **„Zum Home‑Bildschirm“** hinzufügen (iPhone).

---

## 12) Hinweise für die Integration deines Codes

* **Behalte** die existierenden Utils (`gcsVision`, `pdfNaming`, `sidecar`, `inventory`, `subfolder`) **unverändert**.
* `src/index.js` bitte **entkoppeln** von `process.env/argv` und eine Kernfunktion `runSorter(opts)` bereitstellen (siehe Stub oben).
* **GCS Prefix**: verwende `opts.gcsPrefix` für OCR‑Jobs (`input/` & `output/` Pfade).
* **Sidecars/Registry**: genauso wie bisher; `writeMeta`, `writeRegistryEntry` weiterverwenden.
* **OpenAI**: `OPENAI_API_KEY` kommt aus Secret Manager; keine Code‑Änderung nötig, nur Env sicherstellen.

---
