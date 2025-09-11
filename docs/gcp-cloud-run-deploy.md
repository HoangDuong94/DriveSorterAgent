# Drive Sorter – Google Cloud Projekt & Deploy (Kurzleitfaden)

Dieser Leitfaden fasst das aktuelle Setup und die wichtigsten Befehle für Betrieb und Deployments zusammen.

## Projekt & Dienste

- Projekt: `dokumenten-agent`
- Region: `europe-west6` (Zürich)
- Cloud Run Service: `drivesorter-api`
- Runtime Service Account (SA): `drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com`
- GCS Bucket (Artefakte): `drive-sorter-agent-pdf-inbox-837493` (Cross‑Project, EU Multi‑Region)
- Secrets:
  - `openai-api-key` (als Env `OPENAI_API_KEY`)
  - `drivesorter-access-keys` (eine Zeile pro gültigem `X-Access-Key`)

## Voraussetzungen

- Cloud SDK installiert und Login:
  - `gcloud auth login`
  - `gcloud config set project dokumenten-agent`
  - `gcloud config set run/region europe-west6`

## APIs aktivieren (einmalig)

```
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com \
  vision.googleapis.com drive.googleapis.com
```

## Service Account & IAM

- SA anlegen (falls noch nicht vorhanden):
```
gcloud iam service-accounts create drivesorter-runtime \
  --display-name "DriveSorter Runtime"
```

- Secrets Zugriff (beide Secrets):
```
gcloud secrets add-iam-policy-binding openai-api-key \
  --member=serviceAccount:drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

gcloud secrets add-iam-policy-binding drivesorter-access-keys \
  --member=serviceAccount:drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

- GCS Bucket IAM (Cross‑Project Bucket `drive-sorter-agent-pdf-inbox-837493`):
```
gsutil iam ch \
  serviceAccount:drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com:roles/storage.objectAdmin \
  gs://drive-sorter-agent-pdf-inbox-837493

gsutil iam ch \
  serviceAccount:drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com:roles/storage.legacyBucketReader \
  gs://drive-sorter-agent-pdf-inbox-837493
```

- Signed URLs (V4) ohne Keyfile: SA benötigt zusätzlich `roles/iam.serviceAccountTokenCreator` auf sich selbst:
```
gcloud iam service-accounts add-iam-policy-binding \
  drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com \
  --member="serviceAccount:drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

## Bucket Lifecycle (empfohlen)

Löscht OCR‑Zwischenstände nach 1 Tag:

```
cat > lifecycle.json << 'JSON'
{ "rule": [ { "action": { "type": "Delete" }, "condition": { "age": 1 } } ] }
JSON
gsutil lifecycle set lifecycle.json gs://drive-sorter-agent-pdf-inbox-837493
```

## Secrets befüllen/rotieren

- OpenAI Key (neue Version):
```
printf "%s" "$OPENAI_API_KEY" > openai.key
gcloud secrets versions add openai-api-key --data-file=openai.key
```

- Access Keys (eine Zeile pro Key):
```
printf "demo_key\nkey_for_friend_A\n" > access-keys.txt
gcloud secrets versions add drivesorter-access-keys --data-file=access-keys.txt
```

## Deploy nach Cloud Run

- Aus dem Repo‑Root via NPM Script (angepasst auf `dokumenten-agent`):
```
npm run deploy
```

- Alternativ direkt per gcloud (identisch zum Script):
```
gcloud run deploy drivesorter-api \
  --source . \
  --region europe-west6 \
  --service-account drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars=GCP_PROJECT_ID=dokumenten-agent,REGION=europe-west6,\
GCS_BUCKET=drive-sorter-agent-pdf-inbox-837493,GCS_PREFIX=,DS_VERSION=2025-09-10,\
ACCESS_KEYS_SOURCE=secret,ACCESS_KEYS_SECRET_NAME=drivesorter-access-keys,OPENAI_MODEL=gpt-4.1 \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest \
  --cpu=1 --memory=2Gi --concurrency=10 --min-instances=0 --timeout=900
```

## Smoke‑Tests (HTTP)

```
BASE=$(gcloud run services describe drivesorter-api --region europe-west6 --format='value(status.url)')
curl -s "$BASE/version"
curl -s "$BASE/readyz"   # erwartet: {"ok":true, ...}

# Header vorbereiten
KEY='demo_key'
HDR=( -H "Content-Type: application/json" -H "X-Access-Key: $KEY" )

# Share‑Check (URLs/IDs einsetzen)
SRC_URL='https://drive.google.com/drive/folders/<SRC_ID>'
TRG_URL='https://drive.google.com/drive/folders/<TRG_ID>'
curl -s -X POST "$BASE/api/onboard/share-check" "${HDR[@]}" \
  -d "{\"sourceFolder\":\"$SRC_URL\",\"targetRoot\":\"$TRG_URL\"}"

# Save‑Config
EMAIL='friend@example.com'
curl -s -X POST "$BASE/api/onboard/save-config" "${HDR[@]}" \
  -d "{\"email\":\"$EMAIL\",\"sourceFolderId\":\"<SRC_ID>\",\"targetRootFolderId\":\"<TRG_ID>\"}"

# Dry‑Run & Artefakte (Signed URLs)
DR=$(curl -s -X POST "$BASE/api/dry-run" "${HDR[@]}" -d "{\"email\":\"$EMAIL\"}")
RUN_ID=$(echo "$DR" | jq -r '.runId')
curl -s "$BASE/api/runs/$RUN_ID/artifacts?ttlSec=300" -H "X-Access-Key: $KEY" | jq

# Produktiver Run + Status
RUN_ID=$(curl -s -X POST "$BASE/api/run" "${HDR[@]}" -d "{\"email\":\"$EMAIL\"}" | jq -r '.runId')
for i in {1..20}; do curl -s "$BASE/api/runs/$RUN_ID" -H "X-Access-Key: $KEY" | jq -c .; sleep 2; done
```

## Betrieb & Änderungen

- Env‑Variablen aktualisieren (Beispiele):
```
gcloud run services update drivesorter-api --region europe-west6 --update-env-vars=OPENAI_MODEL=gpt-4o-mini
gcloud run services update drivesorter-api --region europe-west6 --timeout=3600
```

- Logs ansehen:
```
gcloud logs tail --region europe-west6 --service drivesorter-api
```

## Troubleshooting

- `/readyz` zeigt `secrets:false` → Secret‑IAM prüfen (secretAccessor auf beide Secrets), `GCP_PROJECT_ID` korrekt?
- 401/403 bei API‑Calls → `X-Access-Key` im Secret, Preflight/CORS (Browser) prüfen.
- 404 `/healthz` → Liveness per `/readyz` oder `/version` prüfen (Cloud Frontend liefert 404 für healthz in manchen Pfaden).
- Signed URLs 403/401 nach Ablauf → `ttlSec` erhöhen oder neu anfordern.

## Hinweis zum Bucket

Aktuell wird der Cross‑Project Bucket `drive-sorter-agent-pdf-inbox-837493` genutzt. Optional kann ein eigener Bucket im Projekt `dokumenten-agent` angelegt und per `GCS_BUCKET` umgestellt werden.

## PowerShell – sichere Deploy‑Befehle

PowerShell parst Argumente anders als Bash. Für `--set-env-vars`/`--update-env-vars` gilt:

- Die gesamte CSV‑Liste als EIN String in Anführungszeichen übergeben, z. B. `"KEY=VALUE,KEY2=VALUE2"`.
- Oder jede Variable separat mit eigenem `--update-env-vars` setzen.

Beispiel (sicher, mit Variablen):

```
$PROJECT = 'dokumenten-agent'
$REGION  = 'europe-west6'
$SERVICE = 'drivesorter-api'
$BUCKET  = 'drive-sorter-agent-pdf-inbox-837493'
$SA      = 'drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com'
$DS_VERSION = Get-Date -Format 'yyyy-MM-dd'

gcloud run deploy $SERVICE `
  --source . `
  --region $REGION `
  --service-account $SA `
  --allow-unauthenticated `
  --set-env-vars "GCP_PROJECT_ID=$PROJECT,REGION=$REGION,GCS_BUCKET=$BUCKET,GCS_PREFIX=,DS_VERSION=$DS_VERSION,ACCESS_KEYS_SOURCE=secret,ACCESS_KEYS_SECRET_NAME=drivesorter-access-keys,OPENAI_MODEL=gpt-4.1,COOKIE_SECURE=1" `
  --set-secrets OPENAI_API_KEY=openai-api-key:latest `
  --cpu=1 --memory=2Gi --concurrency=10 --min-instances=0 --timeout=900
```

Alternative (robust):

```
gcloud run services update $SERVICE --region $REGION --update-env-vars "GCP_PROJECT_ID=$PROJECT"
gcloud run services update $SERVICE --region $REGION --update-env-vars "REGION=$REGION"
gcloud run services update $SERVICE --region $REGION --update-env-vars "GCS_BUCKET=$BUCKET"
gcloud run services update $SERVICE --region $REGION --update-env-vars "GCS_PREFIX="
gcloud run services update $SERVICE --region $REGION --update-env-vars "DS_VERSION=$(Get-Date -Format 'yyyy-MM-dd_HHmmss')"
gcloud run services update $SERVICE --region $REGION --update-env-vars "ACCESS_KEYS_SOURCE=secret"
gcloud run services update $SERVICE --region $REGION --update-env-vars "ACCESS_KEYS_SECRET_NAME=drivesorter-access-keys"
gcloud run services update $SERVICE --region $REGION --update-env-vars "OPENAI_MODEL=gpt-4.1"
gcloud run services update $SERVICE --region $REGION --update-env-vars "COOKIE_SECURE=1"
```

Env prüfen (soll z. B. `GCP_PROJECT_ID = dokumenten-agent` zeigen, nicht verkettet):

```
gcloud run services describe $SERVICE --region $REGION --format "table(spec.template.spec.containers[0].env[].name, spec.template.spec.containers[0].env[].value)"
```

## Häufiger Fehler: Verkettete Env‑Variablen

- Symptom: `/readyz` → `secrets:false`, und `GCP_PROJECT_ID` enthält mehrere Werte (z. B. `"dokumenten-agent REGION=europe-west6 ..."`).
- Ursache: `--set-env-vars` nicht korrekt gequotet → PowerShell hängt Tokens an die erste Variable.
- Fix: Die CSV‑Liste quoten oder jede Variable einzeln updaten (siehe oben). Danach neue Revision erzeugen.

## Cookie‑Secret & Secret‑IAM (Kurz)

```
# Secret anlegen + Version
$bytes = New-Object 'Byte[]' 48; (New-Object System.Random).NextBytes($bytes)
$COOKIE_SECRET = [Convert]::ToBase64String($bytes)
Set-Content -NoNewline cookie-secret.txt $COOKIE_SECRET
gcloud secrets create cookie-secret
gcloud secrets versions add cookie-secret --data-file=cookie-secret.txt
Remove-Item cookie-secret.txt

# IAM binden und im Service referenzieren
$SA = 'drivesorter-runtime@dokumenten-agent.iam.gserviceaccount.com'
gcloud secrets add-iam-policy-binding cookie-secret --member "serviceAccount:$SA" --role "roles/secretmanager.secretAccessor"
gcloud run services update $SERVICE --region $REGION --set-secrets COOKIE_SECRET=cookie-secret:latest

# Access-Key/OPENAI Secrets: secretAccessor ebenfalls vergeben
gcloud secrets add-iam-policy-binding drivesorter-access-keys --member "serviceAccount:$SA" --role "roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding openai-api-key            --member "serviceAccount:$SA" --role "roles/secretmanager.secretAccessor"
```

## PowerShell Smoke‑Tests (Kurz)

```
$BASE = gcloud run services describe drivesorter-api --region europe-west6 --format 'value(status.url)'
Invoke-RestMethod -Uri "$BASE/version"
Invoke-RestMethod -Uri "$BASE/readyz" | ConvertTo-Json -Depth 5

# Session (Cookie setzen)
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$KEY = '<dein_access_key>'
Invoke-RestMethod -Uri "$BASE/api/session" -Method Post -ContentType 'application/json' -Body (@{ accessKey = $KEY } | ConvertTo-Json) -WebSession $session

# Me/Profiles
Invoke-RestMethod -Uri "$BASE/api/me"       -WebSession $session | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "$BASE/api/profiles" -WebSession $session | ConvertTo-Json -Depth 5
```
