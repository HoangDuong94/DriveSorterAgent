# Datenlayout & Benennungsregeln

## Zielstruktur

```
TARGET_ROOT/
  YYYY/
    <Subfolder>/
      Scan/
        <neuer_name>.<ext>
      Texttranskript/
        <neuer_name>.txt
```

- `YYYY` = vierstelliges Jahr (aus LLM oder Heuristik)
- `<Subfolder>` = thematischer Ordner (z. B. Rechnungen, Steuern, Versicherungen, Bank, Verträge, Medizin, Quittungen, Behörden, Sonstiges)

## Dateinamen (LLM-Regeln)

- Behalte die Original-Endung
- Erlaubte Zeichen: `[a-zA-Z0-9-_.]` (Leerzeichen → `-`)
- Kurz & sprechend, z. B.:
  - `rechnung-acme-2025-02-01-12345.pdf`
  - `steuerbescheid-stadt-luzern-2024-05-10.pdf`
- Keine personenbezogenen Namen des Benutzers im Dateinamen

## Transkript

- Plaintext `.txt`, gleicher Basename wie Scan
- Inhalt = reiner OCR‑Text (Vision), ggf. gekürzt/normiert

