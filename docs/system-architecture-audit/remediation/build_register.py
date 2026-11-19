# -*- coding: utf-8 -*-
"""Generates the remediation package from issues_data.py. Run from repo root:
   python -I docs/system-architecture-audit/remediation/build_register.py
Validates that every graph node id / table name cited by an issue exists in system-graph.json (fails otherwise)."""
import json, os, sys, csv, collections, importlib.util

ROOT = os.getcwd()
OUT = os.path.join(ROOT, "docs/system-architecture-audit/remediation")
spec = importlib.util.spec_from_file_location("issues_data", os.path.join(OUT, "issues_data.py"))
D = importlib.util.module_from_spec(spec); spec.loader.exec_module(D)
ISSUES, FIXES = D.ISSUES, D.FIXES
G = json.load(open(os.path.join(ROOT, "docs/system-architecture-audit/system-graph/system-graph.json"), encoding="utf8"))
NODES = {n["id"] for n in G["nodes"]}
TABLES = {n["id"][4:] for n in G["nodes"] if n["id"].startswith("tbl:")}
WFS = {w["name"] for w in G["workflows"]}

bad = []
ids = [i["id"] for i in ISSUES]
assert len(ids) == len(set(ids)), "duplicate issue ids"
for i in ISSUES:
    for n in i["nodes"]:
        if n not in NODES: bad.append((i["id"], "node", n))
    for t in i["tables"]:
        if t not in TABLES: bad.append((i["id"], "table", t))
    for w in i["wf"]:
        if w not in WFS: bad.append((i["id"], "workflow", w))
    for d in i["deps"]:
        if d not in {f["id"] for f in FIXES}: bad.append((i["id"], "fix", d))
fixed = collections.Counter(x for f in FIXES for x in f["issues"])
for i in ISSUES:
    if fixed[i["id"]] != 1: bad.append((i["id"], "fix-coverage", fixed[i["id"]]))
if bad:
    print("VALIDATION FAILED:", bad); sys.exit(1)

SEV_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"]
cnt = lambda key: collections.Counter(i[key] for i in ISSUES)
stats = dict(total=len(ISSUES), sev=cnt("sev"), conf=cnt("conf"), pri=cnt("pri"), cat=cnt("cat"),
             new=sum(1 for i in ISSUES if not i["prev"]), prev=sum(1 for i in ISSUES if i["prev"]))

def entry(i):
    L = [f"### {i['id']} — {i['title']}", ""]
    L.append("| Field | Value |\n|---|---|")
    rows = [("Category", i["cat"]), ("Severity", i["sev"]), ("Priority", i["pri"]), ("Confidence", i["conf"]), ("Impact / Likelihood / Effort", f"{i['imp']} / {i['lik']} / {i['eff']}"),
            ("Evidence basis", {"SRC": "Source/SQL read (not runtime)", "RUN": "Executed in this audit (in-process RLS suite) + source", "LIVE": "Live system"}[i["evidence"]]),
            ("Previous audit ID", i["prev"] or "new in this pass"), ("Affected module", i["module"]), ("Affected files", "<br>".join(f"`{f}`" for f in i["files"])),
            ("Relevant functions", ", ".join(f"`{f}`" for f in i["funcs"]) or "—"), ("Graph node IDs", ", ".join(f"`{n}`" for n in i["nodes"])),
            ("Related workflows", ", ".join(i["wf"]) or "—"), ("Related tables", ", ".join(f"`{t}`" for t in i["tables"]) or "—"), ("Fix package", ", ".join(i["deps"])),
            ("Status", i["status"])]
    for k, v in rows: L.append(f"| {k} | {v} |")
    for k, key in (("Description", "desc"), ("Root cause", "root"), ("Reproduction (safe)", "repro"), ("Impact", "impact"), ("Fix", "fix"),
                   ("Acceptance criteria", "accept"), ("Required tests", "tests"), ("Verification method", "verify"), ("Why this classification", "why")):
        L += ["", f"**{k}.** {i[key]}"]
    L += ["", "---", ""]
    return "\n".join(L)

def table(items):
    L = ["| ID | Title | Sev | Pri | Confidence | Fix pkg | Status |", "|---|---|---|---|---|---|---|"]
    for i in items:
        L.append(f"| {i['id']} | {i['title']} | {i['sev']} | {i['pri']} | {i['conf']} | {', '.join(i['deps'])} | {i['status']} |")
    return "\n".join(L)

srt = lambda items: sorted(items, key=lambda i: (SEV_ORDER.index(i["sev"]), i["pri"], i["id"]))

# ------------------------------------------------------------------ master register
head = f"""# Master Issue Register
Generated from `issues_data.py` (single source). Date: 2026-11-06. Repo: `main` @ `5e951e1`.

**Totals:** {stats['total']} issues ({stats['prev']} preserved from the previous audit with unchanged IDs, {stats['new']} new). Duplicate symptoms are grouped under one root issue.

| Severity | Count |
|---|---|
""" + "\n".join(f"| {s} | {stats['sev'].get(s, 0)} |" for s in SEV_ORDER) + f"""

| Confidence | Count |
|---|---|
""" + "\n".join(f"| {c} | {stats['conf'].get(c, 0)} |" for c in ["Confirmed", "Strong Evidence", "Potential", "Unverified"]) + f"""

| Priority | Count |
|---|---|
""" + "\n".join(f"| {p} | {stats['pri'].get(p, 0)} |" for p in ["P0", "P1", "P2", "P3"]) + """

**Evidence basis.** All findings rest on source/SQL reading. One runtime observation exists: the in-process RLS suite was executed (153 passed, 0 failed; see OPS-02). No live Supabase, Vercel or Hostinger inspection was possible. "Confirmed" means the behaviour follows directly from code that was read (or executed); it does not mean it was observed in production.

**No P0.** No issue is confirmed critical. ARC-01 becomes an immediate patch (interim fix in FX-01) if verification shows that a `ceo` role exists live.

## Register (sorted by severity, then priority)
"""
doc = head + table(srt(ISSUES)) + "\n\n## Issue details\n\n" + "\n".join(entry(i) for i in srt(ISSUES))
open(os.path.join(OUT, "MASTER_ISSUE_REGISTER.md"), "w", encoding="utf8").write(doc)

# ------------------------------------------------------------------ csv
cols = ["Issue ID", "Previous ID", "Title", "Category", "Severity", "Priority", "Confidence", "Impact", "Likelihood", "Effort", "Affected Module", "Affected Files",
        "Relevant Functions", "Graph Node IDs", "Related Workflows", "Related Tables", "Description", "Root Cause", "Reproduction", "Impact Detail", "Fix", "Dependencies (fix packages)",
        "Acceptance Criteria", "Required Tests", "Verification Method", "Classification Rationale", "Evidence Basis", "Status"]
with open(os.path.join(OUT, "MASTER_ISSUE_REGISTER.csv"), "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f); w.writerow(cols)
    for i in srt(ISSUES):
        w.writerow([i["id"], i["prev"], i["title"], i["cat"], i["sev"], i["pri"], i["conf"], i["imp"], i["lik"], i["eff"], i["module"], "; ".join(i["files"]), "; ".join(i["funcs"]),
                    "; ".join(i["nodes"]), "; ".join(i["wf"]), "; ".join(i["tables"]), i["desc"], i["root"], i["repro"], i["impact"], i["fix"], "; ".join(i["deps"]), i["accept"], i["tests"],
                    i["verify"], i["why"], i["evidence"], i["status"]])

# ------------------------------------------------------------------ category files
CATFILES = {"SECURITY_ISSUES.md": ("Security Issues", ["Security"]), "FUNCTIONAL_ISSUES.md": ("Functional & Business Logic Issues", ["Functional"]),
            "DATABASE_ISSUES.md": ("Database & Data Integrity Issues", ["Data"]), "ARCHITECTURE_ISSUES.md": ("Architecture, Dependency & Documentation Issues", ["Architecture", "Documentation"]),
            "PERFORMANCE_ISSUES.md": ("Performance & Scalability Issues", ["Performance"]), "OPERATIONS_ISSUES.md": ("Operations & Infrastructure Issues", ["Operations"]),
            "TESTING_ISSUES.md": ("Testing & Quality Issues", ["Testing"])}
for fn, (title, cats) in CATFILES.items():
    items = srt([i for i in ISSUES if i["cat"] in cats])
    open(os.path.join(OUT, fn), "w", encoding="utf8").write(f"# {title}\n\n{len(items)} issues. Full fields are in MASTER_ISSUE_REGISTER.md; IDs are canonical.\n\n" + table(items) + "\n\n" + "\n".join(entry(i) for i in items))

# ------------------------------------------------------------------ fix dependency graph (mermaid)
FXD = {f["id"]: f for f in FIXES}
M = ["%% Remediation dependency graph. Arrow A --> B means: A must be done (and verified) before B.",
     "%% Colors: red = P1, orange = P2, grey = P3. Shapes: [ ] code-only, [[ ]] needs SQL migration, ([ ]) needs external configuration (dashboard/Hostinger/CI).",
     "%% Notes in the label: D = data cleanup needed, V = needs production verification. No fix requires downtime.",
     "flowchart TD"]
for f in FIXES:
    lab = f"{f['id']}: {f['title']}<br/>{', '.join(f['issues'])}{'<br/>D' if f['cleanup'] else ''}{' V' if f['prod_verify'] else ''}"
    if f["external"]: node = f'{f["id"]}(["{lab}"])'
    elif f["migration"]: node = f'{f["id"]}[["{lab}"]]'
    else: node = f'{f["id"]}["{lab}"]'
    M.append("  " + node)
for f in FIXES:
    for n in f["needs"]: M.append(f"  {n} --> {f['id']}")
M += ["  classDef p1 fill:#fdd,stroke:#c33;", "  classDef p2 fill:#ffe9c7,stroke:#c80;", "  classDef p3 fill:#eee,stroke:#888;"]
for p in ("p1", "p2", "p3"):
    xs = [f["id"] for f in FIXES if f["pri"].lower() == p]
    if xs: M.append(f"  class {','.join(xs)} {p};")
M.append("  %% Final gate: every package ends with production verification (VERIFICATION_PLAN.md) before its issues move to Verified.")
open(os.path.join(OUT, "REMEDIATION_DEPENDENCY_GRAPH.mmd"), "w", encoding="utf8").write("\n".join(M) + "\n")

json.dump({"stats": {k: (dict(v) if isinstance(v, collections.Counter) else v) for k, v in stats.items()}}, open(os.path.join(OUT, "stats.json"), "w"), indent=1)
print("OK", stats["total"], dict(stats["sev"]), dict(stats["conf"]), dict(stats["pri"]), "new", stats["new"])
