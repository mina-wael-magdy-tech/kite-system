# System graph (Graph B) and workflow graphs (Graph C)

| File | What it is |
|---|---|
| `system-architecture.html` | **Interactive viewer**, self-contained (no network). Zoom/pan, search, filter by layer / module / relation, presets (request path, ER, security/RLS, critical), node detail panel (purpose, responsibility, source, functions, DB reads/writes, API calls, security boundary, known issues, Graphify symbols/communities, evidence), 8 traceable workflows. Deep links: `#preset=req|all|er|sec|crit`, `&wf=0..7`, `&sel=fn:kite-drive`, `&q=text`. |
| `system-graph.json` | The graph: 410 nodes, 1050 edges, 8 workflows. Each edge: `relation`, `kind` (extracted / curated / inferred), `evidence` (file:line), optional `labels`. |
| `build_system_graph.py` | Extractor. Run from the repo root: `python -I docs/system-architecture-audit/system-graph/build_system_graph.py`. Read-only on the repo; writes only into this folder. |
| `build_viewer.py`, `viewer_template.html` | Embed the JSON into the template to produce `system-architecture.html`. |

## Provenance
- **extracted** (1003 edges): regex over source. SQL migrations (tables, 124 FKs, 175 RLS policies, 44 SQL functions, 48 trigger instances), `.from()` / `.rpc()` / `Api.*` call sites in JS and TS, PHP SQL strings and actions.
- **curated** (47 edges): read during the audit; each is guarded by an assertion that a cited string exists in a cited file. An edge whose assertion fails is downgraded to `inferred` (none did).
- **inferred**: only two workflow steps (invite-employee trigger; table-to-Realtime link).
- Workflow steps marked `extracted` must be backed by an actual graph edge; the build downgrades and reports any that are not (it did so for 3 steps during development and they were fixed in the extractor).

## Known limitations
- Browser modules were mapped from call sites, not read line by line. Dynamic table names would be missed (some tables show no writer).
- Policies are linked to helper functions by name; policy logic is not evaluated. Policies created in `format()` loops are recognised only for the `CREATE POLICY` pattern used in migration 017.
- `set_updated_at` triggers: 003 creates them in a loop; the table set is reconstructed from tables created in 001 that have an `updated_at` column.
- PHP: SQL edges are regex over strings; `db.php` / `auth.php` are not in the repo.
- No runtime evidence. Purposes of most tables are marked `inferred` (from name and migration only).
- Layout is a force simulation, so node positions vary between loads. Viewer behaviour was checked in headless Chrome only.

## Publication
Published in Notion under **Kite System**. A hosted link for the interactive viewer was **not** created: the publish step was blocked by a permission prompt and was not retried.
