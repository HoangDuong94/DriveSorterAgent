# Akzeptanzkriterien (DoD)

1. Simulation:
   - `--dry-run` erzeugt für jede Datei einen vollständigen Plan ohne Drive‑Writes
2. Ablage:
   - Originaldatei landet in `YYYY/Subfolder/Scan/<new>`
   - Transkript liegt in `YYYY/Subfolder/Texttranskript/<basename>.txt`
3. Jahr/Ordner:
   - Jahresregel strikt; Subfolder aus LLM oder Fallback (`Sonstiges`)
4. GCS Cleanup:
   - pro Datei: Input + Output (PDF) entfernt
   - optional: kompletter Prefix‑Flush bei `CLEAR_GCS_PREFIX_ON_EXIT=1`
5. Fehlerrobustheit:
   - LLM‑Antwort nicht parsebar → deterministischer Fallback aktiv
   - Kein Transkript → neutraler Name + `Sonstiges`
6. Logs:
   - Klare Plan‑Blöcke, inkl. „existiert / würde erstellt“

