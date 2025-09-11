# Drive Sorter – Agents Guide

Dieses Dokument richtet sich an Agenten/Auto‑Coder, die in diesem Repository arbeiten. Es beschreibt Architektur, Coding‑Konventionen, lokale Ausführung, Secrets, Deployments und häufige Stolperfallen.

## Architektur (Kurzüberblick)

- API (Fastify)
  - `api/server.js` – Bootstrap (CORS, Auth‑Hook, Routing)
  - `api/routes/health.js` – `GET /readyz`
  - `api/routes/onboard.js` – `POST /share-check`, `POST /save-config`
  - `api/routes/runs.js` – `POST /dry-run`, `POST /run`, `GET /runs/:id`, `GET /runs/:id/artifacts`
- Services
  - `services/auth.js` – Access‑Keys aus Secret Manager (LRU Cache, 5 min)
  - `services/configStore.js` – User‑Config in GCS (`configs/<email-hash>.json`)
  - `services/runsStore.js` – Run‑Orchestrierung (Status/Logs in `runs/<runId>/`); Signed URLs + Ownership‑Prüfung
  - `services/driveSorter.js` – Adapter auf bestehende Logik (`runSorter(opts)`) aus `src/index.js`
- Libs
  - `lib/google.js` – Drive‑Client via ADC
  - `lib/id.js` – Drive‑ID aus URL extrahieren
- Bestandscode
  - `src/index.js` – Kernlogik, exportiert `runSorter(opts)`; ADC‑Fallback integriert
  - `src/utils/*` – GCS‑OCR, Prompt/Naming, Inventory, Sidecars, etc.

## Auth & Sicherheit

- Request‑Auth: Header `X-Access-Key` (Werte in Secret `drivesorter-access-keys`, eine Zeile pro Key).
- Lokaler Modus: Mit `ACCESS_KEYS_SOURCE=env` und `ACCESS_KEYS=demo_key` kann ohne Secret Manager getestet werden.
- Secrets niemals commiten. `.gitignore` enthält `.env`, `credentials.json`, `openai.key` etc.
- GitHub Push Protection blockt Secrets; beim Testen keine Keys in Dateien/Commits ablegen.

## Signed URLs & Ownership

- Route `GET /api/runs/:runId/artifacts?ttlSec=...` erzeugt V4 Signed URLs für GCS‑Artefakte (`status.json`, optional `logs.ndjson`).
- Ownership: Beim Start (`dry-run`/`run`) wird `{ meta: { email, accessKeyHash } }` in `status.json` geschrieben. Der Abruf der Signed URLs erfordert den selben `X-Access-Key` (SHA‑256 Vergleich).
- TTL Clamp: Standard 3600 s, min 60 s, max 86400 s.
- Erforderliche IAM: Runtime‑SA hat `roles/iam.serviceAccountTokenCreator` (Signierung) und GCS‑Rollen (objectAdmin + bucketReader bei Cross‑Project).

## Lokale Ausführung

- Voraussetzungen: Node.js ≥ 18, npm.
- Schnellstart:
  - `.env` (lokal) mit Testwerten, z. B. `ACCESS_KEYS_SOURCE=env`, `ACCESS_KEYS=demo_key`, `GCS_BUCKET=…`
  - Start: `npm run dev` (lauscht auf `:8080`)
- HTTP‑Smoke:
  - `GET /version`, `GET /readyz`
  - `POST /api/onboard/share-check` (mit Drive‑URLs/IDs + `X-Access-Key`)
  - `POST /api/dry-run` / `POST /api/run` → `GET /api/runs/:id`

## Deployment (Cloud Run)

- NPM‑Script: `npm run deploy` (auf Projekt `dokumenten-agent` angepasst; Env via `--set-env-vars=...`).
- Relevante Env im Service: `GCP_PROJECT_ID`, `REGION`, `GCS_BUCKET`, `GCS_PREFIX`, `DS_VERSION`, `ACCESS_KEYS_*`, `OPENAI_MODEL`.
- Vorsicht in PowerShell: `--set-env-vars=KEY=VALUE` verwenden (nicht die CSV‑Variante ohne `=`), sonst werden Werte „zusammengeklebt“.

## GCS Bucket

- Aktuell: Cross‑Project Bucket `drive-sorter-agent-pdf-inbox-837493` (EU). Cloud Run läuft im Projekt `dokumenten-agent`.
- Wechsel auf Projekt‑eigenen Bucket möglich → `GCS_BUCKET` aktualisieren, Bucket‑IAM setzen, `/readyz` prüfen.
- OCR‑Lifecycle empfohlen: Delete nach 1 Tag.

## Coding‑Konventionen

- CommonJS, keine TS‑Buildkette.
- Kleine, fokussierte Änderungen; Bestandscode‑Stil beibehalten.
- Fehlerpfade: strukturierte JSON‑Fehler `{ error: { code, message, details? } }`.
- CORS: via `@fastify/cors` konfiguriert; `X-Access-Key` in `allowedHeaders` lassen.

## Tests / DoD‑Hinweise

- `/readyz` grün: Storage/Secrets/Vision.
- `share-check`: ok:true nur bei `canEdit && canAddChildren` für beide Ordner.
- `dry-run`/`run`: Statusdatei `runs/<runId>/status.json` vorhanden; `artifacts` Route liefert gültige Signed URLs.
- Ownership‑Negativtest: Falscher Key bei `/artifacts` → 403 `forbidden-run-ownership`.

## Häufige Stolperfallen

- `healthz` 404 über das Google Frontend → für Liveness `readyz`/`version` nutzen.
- Secret‑Zugriff rot in `/readyz` → `roles/secretmanager.secretAccessor` auf beide Secrets + korrektes `GCP_PROJECT_ID` sicherstellen.
- PowerShell Quoting: `--update-env-vars=KEY=VALUE` pro Variable; ansonsten landen mehrere Werte in einer Env.
- GCS Append: `logs.ndjson` ist best‑effort; Frontend soll nicht darauf angewiesen sein (Status polling nutzen).

## Hinweise für Agenten

- Keine destruktiven Migrationsschritte ohne Rücksprache (z. B. massenhaftes Löschen in GCS/Drive).
- Keine zusätzlichen externen Abhängigkeiten ohne Bedarf; schlanke Implementierungen bevorzugen.
- Bei neuen Endpunkten: CORS, Auth, strukturierte Fehler und Tests (curl‑Snippets) mitliefern.

