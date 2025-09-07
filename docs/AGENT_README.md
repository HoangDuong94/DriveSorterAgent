# Codex Agent – Übersicht & Quickstart

Ziel: Eingangsordner in Google Drive auslesen, mit GCS Vision reinen Text erstellen, OpenAI (gpt‑4.1) für Benennung/Zielpfad konsultieren, Dateien (1) in `YYYY/Subfolder/Scan` verschieben und (2) das Texttranskript in `YYYY/Subfolder/Texttranskript` ablegen. Am Ende GCS-Artefakte aufräumen. Zusätzlich ein Read‑Only (DRY RUN) zur sicheren Simulation.

## Voraussetzungen

- Node.js ≥ 18
- Google Cloud Projekt mit:
  - Drive API aktiviert
  - Vision API aktiviert
  - Service Account + `credentials.json`
  - GCS Bucket (z. B. `my-drivesorter`)
- OpenAI API‑Key
- Drive‑Ordner: ein SOURCE (Eingang) & ein TARGET_ROOT (Ziel)

## Installation

```bash
npm ci # oder: npm install
```

## Konfiguration (.env)

```env
# OpenAI
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="gpt-4.1"            # optional, Default gpt-4.1

# Google Drive
SOURCE_FOLDER_ID="..."            # ID oder Name
TARGET_ROOT_FOLDER_ID="..."       # ID oder Name
GOOGLE_APPLICATION_CREDENTIALS="./credentials.json"

# Google Cloud Storage (GCS) für OCR
GCS_BUCKET="my-drivesorter"
GCS_PREFIX="drivesorter"          # optional, Default: drivesorter

# Verhalten
DRY_RUN="0"                       # 1 = Read-only Simulation
VISION_MAX_PAGES="3"              # für PDF->Vision-Preview (0 = alle)
CLEAR_GCS_PREFIX_ON_EXIT="0"      # 1 = gesamtes Prefix am Ende leeren

# Optional Debugging
OCR_DPI="300"
OCR_DEBUG="0"
```

## Start

Simulation (Read‑Only):

```bash
node src/index.js --dry-run
# oder
DRY_RUN=1 node src/index.js
```

Ausführen (schreibend):

```bash
npm start
# entspricht: node src/index.js
```

## Ergebnis

- Originale landen in: `TARGET_ROOT/YYYY/<Subfolder>/Scan/<neuer_name>.<ext>`
- Transkript landet in: `TARGET_ROOT/YYYY/<Subfolder>/Texttranskript/<neuer_name>.txt`
- GCS Input/Outputs werden pro Datei aufgeräumt (optional: gesamtes Prefix am Ende).

