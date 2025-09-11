````markdown
# Backend-Anforderung – Usability‑Upgrade DriveSorter API

**Version:** 0.1  
**Datum:** 2025‑09‑11  
**Status:** Entwurf zur Umsetzung

## 1) Zielsetzung

Die Backend‑API soll so erweitert werden, dass die App ohne technische Vorkenntnisse nutzbar ist:

- **Kein** manuelles Eintippen von Access‑Key in jedem Request (Session).
- **Keine** Drive‑IDs nötig (Links/Name werden serverseitig aufgelöst).
- **Profile/Konfigurationen** pro Nutzer speicher- und wiederverwendbar.
- **Dry‑Run** liefert eine **UI‑freundliche Vorschau** (von → nach, Gründe, Duplikate).
- **Produktivlauf** führt genau diese Vorschau aus.
- **Live‑Status** via **SSE** (Server‑Sent Events).

> Sicherheit ist in dieser Phase **nicht** Schwerpunkt; grundlegende Absicherung via Access‑Key bleibt bestehen. Härtung folgt in einem späteren Schritt.

---

## 2) In Scope / Out of Scope

**In Scope**
- Sessionbasierte Auth auf Basis des bestehenden Access‑Keys.
- Profile/Configs je Nutzer (Erstellung, Liste, Standardprofil).
- „Resolve“ von Drive‑Ordnern (Link/Name/ID → ID + Rechte).
- Dry‑Run‑Ergebnis als strukturierte Vorschau.
- SSE‑Stream für Fortschritt/Status/Logs.

**Out of Scope (Phase 1)**
- Vollständige OAuth‑User Accounts & RBAC.
- Tiefgreifende Security‑Härtung (CSRF‑Schutz, Refresh‑Tokens etc.).
- Mehrsprachigkeit der API (Responses bleiben deutsch/englisch gemischt, wo vorhanden).

---

## 3) Betroffene Komponenten (Ist‑Stand im Repo)

- `api/server.js` – Auth‑Hook, CORS, Routing
- `api/routes/onboard.js` – share‑check, save‑config
- `api/routes/runs.js` – dry‑run/run/status/artifacts
- `services/configStore.js` – (De)Persistenz User‑Config (GCS)
- `services/runsStore.js` – Run‑Orchestrierung & Artefakte
- `src/index.js` – Sorter‑Engine (Dry‑Run/Run‑Logik)
- `src/utils/*` – OCR/Prompting/Inventory/Sidecar

---

## 4) API – Neue/erweiterte Endpunkte

### 4.1 Session (neu)

**POST** `/api/session`  
Legt eine Session‑Cookie für den Access‑Key an (HttpOnly).

**Request**
```json
{ "accessKey": "my-secret-key" }
````

**Response 200**

```json
{ "ok": true }
```

**Side‑Effects**

* Set‑Cookie: `ds_session=<AccessKey>; HttpOnly; SameSite=Lax; Secure?(prod)`

**Server-Verhalten**

* Der bestehende `onRequest`‑Hook akzeptiert künftig **Header `X-Access-Key` ODER Cookie `ds_session`**.

---

### 4.2 Me (neu)

**GET** `/api/me`
Gibt die technische Identität der Session zurück.

**Response 200**

```json
{
  "ownerHash": "<sha256(accessKey)>",
  "defaultProfileId": "pr_abc123"
}
```

---

### 4.3 Profile (neu)

**GET** `/api/profiles`
Liste aller Profile der Session.

**Response 200**

```json
{
  "items": [
    {
      "id": "pr_abc123",
      "label": "Privat",
      "sourceFolderId": "AAA...",
      "targetRootFolderId": "BBB...",
      "settings": {
        "allow_new_subfolders": false,
        "duplicates": { "policy": "skip", "rename_suffix": "dup", "subfolder_name": "Duplikate" }
      },
      "gcsPrefix": "users/<ownerHash>",
      "updatedAt": "2025-09-11T10:00:00Z"
    }
  ],
  "defaultId": "pr_abc123"
}
```

**POST** `/api/profiles`
Erstellt/aktualisiert ein Profil.

**Request**

```json
{
  "label": "Privat",
  "sourceFolderId": "AAA...",
  "targetRootFolderId": "BBB...",
  "settings": { "allow_new_subfolders": false }
}
```

**Response 200**

```json
{ "ok": true, "profile": { "...": "..." } }
```

**PUT** `/api/profiles/:id/default`
Setzt ein Profil als Standard.
**Response 200** `{ "ok": true, "id": "pr_abc123" }`

*(Optional in Phase 1: `GET /api/profiles/:id`, `DELETE /api/profiles/:id`)*

---

### 4.4 Onboarding – Resolver & Inventory (neu) + Share‑Check (erweitert)

**GET** `/api/onboard/resolve?q=<id|url|name>`
Löst Ordner‑ID/Name/Link auf und liefert Rechtehinweise.

**Response 200**

```json
{
  "id": "AAA...",
  "name": "Eingang",
  "mimeType": "application/vnd.google-apps.folder",
  "canEdit": true,
  "canAddChildren": true
}
```

**GET** `/api/onboard/target-inventory?targetRootId=BBB...`
Kompakte Vorschau der Zielstruktur (Text).

**Response 200**

```json
{ "ok": true, "inventoryText": "Rechnungen/\n  2025/\n  - rechnung-..." }
```

**POST** `/api/onboard/share-check` *(bestehend, **erweitert**)*

**Request**

```json
{ "sourceFolder": "<id|url>", "targetRoot": "<id|url>" }
```

**Response 200**

```json
{
  "ok": true,
  "source": { "id":"...", "name":"...", "canEdit":true, "canAddChildren":true },
  "target": { "id":"...", "name":"...", "canEdit":true, "canAddChildren":true }
}
```

**Response 403 (freundlicher)**

```json
{
  "ok": false,
  "source": { "id":"...", "error": "forbidden" },
  "target": { "id":"...", "error": "forbidden" },
  "hint": {
    "serviceIdentityEmail": "drivesorter-runtime@...iam.gserviceaccount.com",
    "action": "Bitten Sie den Ordner-Eigentümer, der obigen Identität 'Bearbeiten' zu gewähren."
  }
}
```

---

### 4.5 Runs & Vorschau

**POST** `/api/dry-run` *(bestehend, erweitert)*

**Request (neu bevorzugt)**

```json
{ "profileId": "pr_abc123" }
```

**Backward‑Compatible Request**

```json
{ "email": "user@example.com" }
```

**Response 200 (erweitert um `summary.preview[]`)**

```json
{
  "ok": true,
  "runId": "run_2025-09-11T10:12:00_8f2c1a",
  "summary": {
    "processed": 42,
    "moved": 0,
    "errors": 1,
    "counts": { "duplicates": 3, "gcs_ocr": 40, "gcs_ocr_image": 2 },
    "preview": [
      {
        "fileId": "1Abc...",
        "originalName": "scan123.pdf",
        "mime": "application/pdf",
        "detected": {
          "dateISO": "2025-02-01",
          "sender": "ACME GmbH",
          "invoiceNumber": "12345",
          "category": "Rechnungen"
        },
        "proposed": {
          "year": "2025",
          "subfolder": "Rechnungen",
          "newFilename": "rechnung-acme-gmbh-2025-02-01-12345.pdf",
          "transcriptName": "rechnung-acme-gmbh-2025-02-01-12345.txt",
          "wouldMoveTo": "2025/Rechnungen/Scan/rechnung-....pdf",
          "wouldWriteTranscriptTo": "2025/Rechnungen/Texttranskript/rechnung-....txt"
        },
        "exists": {
          "Rechnungen": true,
          "Rechnungen/2025": false,
          "Rechnungen/2025/Scan": false,
          "Rechnungen/2025/Texttranskript": false
        },
        "duplicateOf": null
      },
      { "fileId":"2Xyz...", "originalName":"doppelt.pdf", "duplicateOf": { "fileId":"1X..", "originalName":"scan_vorher.pdf" }, "policy":"skip" }
    ]
  }
}
```

**POST** `/api/run` *(bestehend, erweitert)*

**Request**

```json
{ "profileId": "pr_abc123" }
```

**Response 202**

```json
{ "ok": true, "runId": "..." }
```

**GET** `/api/runs/:runId` *(bestehend)*
Unverändert, enthält aber künftig in `status.json` ebenfalls die `summary.preview[]`, sobald vorhanden.

**GET** `/api/runs/:runId/stream` *(neu, SSE)*
Content‑Type `text/event-stream`; alle \~1s `data: { ...status.json... }\n\n`.
Stream endet bei `state in ["succeeded","failed"]`.

**GET** `/api/runs/:runId/artifacts` *(bestehend)*
Unverändert (liefert signierte URLs); Zugriff weiter an `accessKeyHash` gebunden.

---

## 5) Datenmodell & Storage

### 5.1 Profiles in GCS (neu)

```
configs/owners/<ownerHash>/profiles/<profileId>.json
configs/owners/<ownerHash>/default.json
```

**Profile‑Schema**

```json
{
  "id": "pr_abc123",
  "label": "Privat",
  "sourceFolderId": "AAA...",
  "targetRootFolderId": "BBB...",
  "settings": {
    "allow_new_subfolders": false,
    "duplicates": { "policy": "skip", "rename_suffix": "dup", "subfolder_name": "Duplikate" }
  },
  "gcsPrefix": "users/<ownerHash>",
  "updatedAt": "ISO-8601"
}
```

**ownerHash** = `sha256(accessKey)` (hex, lowercase).

### 5.2 Runs (bestehend, **ergänzt**)

```
runs/<runId>/status.json      // enthält state, mode, summary.preview[]
runs/<runId>/logs.ndjson
```

`status.json.meta` wird erweitert um:

```json
{ "ownerHash": "<sha256(accessKey)>", "profileId": "pr_abc123", "email": "..." }
```

---

## 6) Auth/Session

* **Akzeptiert**: Header `X-Access-Key` **oder** Cookie `ds_session`.
* **Cookie**: HttpOnly, SameSite=Lax, `Secure` in Produktion.
* `ownerHash` wird aus Access‑Key abgeleitet (sha256).

---

## 7) Dry‑Run‑Vorschau – Struktur

**PreviewItem (Schema)**

```json
{
  "fileId": "string",
  "originalName": "string",
  "mime": "string",
  "detected": {
    "dateISO": "YYYY-MM-DD|null",
    "sender": "string|null",
    "invoiceNumber": "string|null",
    "category": "string|null"
  },
  "proposed": {
    "year": "YYYY",
    "subfolder": "string",
    "newFilename": "string",
    "transcriptName": "string",
    "wouldMoveTo": "path",
    "wouldWriteTranscriptTo": "path"
  },
  "exists": {
    "<Sub>": true,
    "<Sub>/YYYY": false,
    "<Sub>/YYYY/Scan": false,
    "<Sub>/YYYY/Texttranskript": false
  },
  "duplicateOf": { "fileId":"...", "originalName":"..." } | null,
  "policy": "skip|move|null"
}
```

---

## 8) Fehlerformat (Standard)

Alle Fehler folgen:

```json
{ "error": { "code": <http-status>, "message": "<slug>", "detail": "optional text" } }
```

Beispiele:

* `401 Unauthorized` – `{ "error": { "code": 401, "message": "unauthorized" } }`
* `403 Forbidden` – `{ "error": { "code": 403, "message": "forbidden" } }`
* `422 Unprocessable` – `{ "error": { "code": 422, "message": "missing-fields", "detail": "..." } }`
* `500 Server` – `{ "error": { "code": 500, "message": "internal", "detail": "..." } }`

---

## 9) Konfiguration / ENV

Neu/erweitert:

* `COOKIE_SECRET` – Signatur/Encryption Secret (Pflicht in Prod).
* `COOKIE_SECURE` – `"1"` in Prod.
* *(optional)* `SERVICE_IDENTITY_EMAIL` – wird in /share‑check‑Hints ausgegeben, falls `about.get` nicht zuverlässig.
* Bereits vorhanden: `GCS_BUCKET`, `GCS_PREFIX`, `DS_VERSION`, `OPENAI_MODEL`, `ACCESS_KEYS_SOURCE`, `ACCESS_KEYS_SECRET_NAME`, `GCP_PROJECT_ID`, `REGION`.

---

## 10) Migration & Rückwärtskompatibilität

1. **Session parallel** zu `X-Access-Key` akzeptieren.
2. **Runs**: Body kann weiterhin `email` senden. Wenn **kein `profileId`**, versuche `loadUserConfig(email)`.
3. Beim ersten Session‑Login kann (optional) das bestehende `configs/<emailHash>.json` in ein Default‑Profil unter `configs/owners/<ownerHash>/...` konvertiert werden.
4. UI darf schrittweise von `email` auf `profileId` umstellen.

---

## 11) Qualitätskriterien (Akzeptanz)

* [ ] `POST /api/session` setzt ein HttpOnly‑Cookie; Folge‑Requests ohne Header funktionieren.
* [ ] `GET /api/profiles` zeigt mind. ein Profil; `PUT /api/profiles/:id/default` wirkt.
* [ ] `GET /api/onboard/resolve` akzeptiert ID, Link oder Name und liefert Rechte.
* [ ] `POST /api/onboard/share-check` liefert bei 403 einen klaren Hinweis mit Service‑Identität.
* [ ] `POST /api/dry-run` (mit `profileId`) liefert `summary.preview[]` mit min. 1 Item.
* [ ] `POST /api/run` triggert Ausführung; `GET /api/runs/:runId/stream` streamt Status bis Abschluss.
* [ ] `GET /api/runs/:runId/artifacts` liefert signierte URLs bei passendem Access‑Key.
* [ ] Rückwärtskompatibilität: `email`‑basierte Flows funktionieren weiterhin.

---

## 12) Testplan (Auszug)

* **Unit**

  * `services/configStore`: save/list/setDefault Profile; ownerHash korrekt.
  * `api/server`: Session‑Cookie akzeptiert; Header weiterhin akzeptiert.
* **Integration / E2E**

  * Wizard‑Flow: session → resolve → share‑check → profile create → dry‑run (preview) → run (SSE).
  * Negative Cases: fehlender Zugriff (403), unbekannter Ordner (404), fehlende Felder (422).
* **Smoke**

  * Health `/readyz` weiterhin ok (Storage/Secrets/Vision Checks bleiben).

---

## 13) Implementierungs‑Hinweise (konkret)

### 13.1 `api/server.js`

* `@fastify/cookie` registrieren.
* Neue Route `POST /api/session`.
* `onRequest`: Access‑Key aus Header **oder** Cookie akzeptieren; bestehende Secret‑Manager‑Logik wiederverwenden.

### 13.2 `services/configStore.js`

* **Neu:** `saveProfile({ ownerHash, profile })`, `listProfiles(ownerHash)`, `setDefaultProfile(ownerHash, id)`.
* Bestehende `saveUserConfig/loadUserConfig` **beibehalten** (Migration/Kompatibilität).

### 13.3 `api/routes/profiles.js` (neu)

* Implementiert `GET /api/profiles`, `POST /api/profiles`, `PUT /api/profiles/:id/default`, `GET /api/me`.

### 13.4 `api/routes/onboard.js`

* **Neu:** `GET /api/onboard/resolve`, `GET /api/onboard/target-inventory`.
* **Erweitern:** `/api/onboard/share-check` um `hint.serviceIdentityEmail`.

### 13.5 `api/routes/runs.js`

* **Neu:** `GET /api/runs/:runId/stream` (SSE).
* **Erweitern:** `POST /dry-run` und `POST /run` akzeptieren `profileId` (bevorzugt) **oder** `email` (Legacy).

### 13.6 `services/runsStore.js`

* `startDryRun/startRun`: `meta` um `ownerHash`, `profileId` ergänzen.
* `startDryRun`: `summary.preview[]` aus Engine übernehmen und in `status.json` persistieren.

### 13.7 `src/index.js` (Engine)

* Im **Dry‑Run‑Zweig** pro verarbeitetem File ein `preview`‑Item füllen (siehe Schema).
* `main()` Ergebnis `summary.preview` zurückgeben (auch via `runSorter`).
* Duplikate/Ensure‑Checks/LLM‑Vorschläge wie heute nutzen; Daten in `preview` mappen.

---

## 14) Nicht‑funktional

* **SSE Interval**: 1s; Timeouts/Abbruch sauber handhaben.
* **CORS**: bleibt `origin: true`.
* **Logging**: keine PII in Logs; Access‑Key **nie** loggen.
* **Leistung**: Unverändert; Profil‑Reads aus GCS sind klein.

---

## 15) Nacharbeiten (Security – spätere Phase)

* CSRF‑Schutz für Cookie‑basierte Session (SameSite+Token).
* Key‑Rotation & Token‑Ablauf.
* „Run‑Ownership“ sauberer als nur `accessKeyHash`.

---

## 16) Anhang – JSON‑Schemata (vereinfachte)

**RunStatus (status.json)**

```json
{
  "ok": true,
  "runId": "string",
  "state": "running|succeeded|failed",
  "mode": "dry|run",
  "meta": { "ownerHash": "string", "profileId": "string|null", "email": "string|null", "accessKeyHash": "string" },
  "progress": { "current": 10, "total": 42 },
  "summary": {
    "processed": 42, "moved": 40, "errors": 2,
    "counts": { "duplicates": 3, "gcs_ocr": 40, "gcs_ocr_image": 2 },
    "preview": [ /* PreviewItem[] (nur Dry‑Run garantiert) */ ]
  },
  "error": "string|optional"
}
```

**Error**

```json
{ "error": { "code": 422, "message": "missing-fields", "detail": "profileId or email required" } }
```

---

## 17) Deployment‑Hinweise

* `COOKIE_SECRET` in Prod setzen.
* (Optional) `SERVICE_IDENTITY_EMAIL` setzen, falls `about.get` die SA‑Mail nicht zuverlässig liefert.
* Cloud Run Flags bleiben unverändert; neue Routen automatisch verfügbar.

---

```
::contentReference[oaicite:0]{index=0}
```
