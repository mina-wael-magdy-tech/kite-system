#!/usr/bin/env python3
"""Builds the Kite System architecture graph (Graph B) + workflow graphs (Graph C) from the repository sources.

Run from the repo root:  python -I docs/system-architecture-audit/system-graph/build_system_graph.py

Edge provenance (field `kind`):
  extracted  - found by regex in source; `evidence` holds file:line
  curated    - read manually during the audit (file named in `evidence`); verified by an assert on the file text
  inferred   - plausible but NOT verified in code; shown dashed in the viewer
Nothing is added without one of these tags. Read-only: writes only into docs/system-architecture-audit/system-graph/.
"""
import json, re, os, sys, glob, collections

ROOT = os.getcwd()
OUT = os.path.join(ROOT, "docs/system-architecture-audit/system-graph")
GRAPHIFY_JSON = os.path.join(ROOT, "docs/system-architecture-audit/graphify/graph.json")


def rd(p):
    with open(os.path.join(ROOT, p), encoding="utf8") as f:
        return f.read()


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def files(pattern):
    return sorted(os.path.relpath(p, ROOT).replace("\\", "/") for p in glob.glob(os.path.join(ROOT, pattern), recursive=True))


nodes, edges = {}, []
edge_keys = {}


def node(id, label, layer, module="", **kw):
    n = nodes.setdefault(id, {"id": id, "label": label, "layer": layer, "module": module, "kind": "extracted"})
    n.update({k: v for k, v in kw.items() if v not in (None, "", [])})
    return n


def edge(src, dst, rel, kind, evidence, label=None):
    key = (src, dst, rel)
    if key in edge_keys:
        e = edge_keys[key]
        if evidence not in e["evidence"] and len(e["evidence"]) < 6:
            e["evidence"].append(evidence)
        if label and label not in e.get("labels", []):
            e.setdefault("labels", []).append(label)
        return
    e = {"source": src, "target": dst, "relation": rel, "kind": kind, "evidence": [evidence]}
    if label:
        e["labels"] = [label]
    edge_keys[key] = e
    edges.append(e)


# ------------------------------------------------------------------ domain tags for tables (from migration grouping / names)
DOMAIN = {}
for d, names in {
    "identity": "profiles roles permissions role_permissions user_roles user_departments teams departments invitations",
    "tasks": "tasks task_assignees task_checklists task_checklist_items task_comments task_attachments task_activity_logs task_handoffs task_links task_time_entries",
    "projects": "projects project_members project_departments milestones campaigns campaign_members campaign_departments",
    "clients": "clients client_contacts client_departments client_activities client_billing client_drive_links leads opportunities",
    "content": "content_plans content_posts content_post_assets content_feedback content_plan_shares assets",
    "hr": "attendance_records leave_requests leave_types holidays employee_documents",
    "finance": "invoices invoice_items invoice_payments invoice_number_seq retainer_plans finance_settings finance_audit_log expenses expense_approvals budgets vendors money_figures",
    "comms": "conversations conversation_members messages message_attachments message_reactions notifications notification_preferences push_subscriptions broadcasts",
    "system": "audit_logs company_settings",
}.items():
    for t in names.split():
        DOMAIN[t] = d

# ------------------------------------------------------------------ SQL: tables, FKs, policies, functions, triggers
mig = files("supabase/migrations/*.sql")
mig_text = {m: rd(m) for m in mig}
tables = {}
for m in mig:
    t = mig_text[m]
    for mt in re.finditer(r"CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)", t):
        name = mt.group(1)
        if name not in tables:
            tables[name] = (m, line_of(t, mt.start()))
for name, (m, ln) in tables.items():
    node("tbl:" + name, name, "database", DOMAIN.get(name, "other"), file=f"{m}:L{ln}", ntype="table",
         domain=DOMAIN.get(name, "other"))

# foreign keys
for m in mig:
    t = mig_text[m]
    cur = None
    for i, ln in enumerate(t.split("\n"), 1):
        mt = re.search(r"CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)", ln)
        if mt:
            cur = mt.group(1)
        mt = re.search(r"ALTER TABLE (?:IF EXISTS )?(?:ONLY )?public\.(\w+)", ln)
        if mt:
            cur = mt.group(1)
        for ref in re.finditer(r"REFERENCES public\.(\w+)\s*\((\w+)\)(?:\s+ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION))?", ln):
            if cur and f"tbl:{cur}" in nodes and f"tbl:{ref.group(1)}" in nodes:
                col = re.match(r"\s*(?:ADD COLUMN (?:IF NOT EXISTS )?)?(\w+)", ln)
                col = col.group(1) if col and col.group(1).upper() not in ("FOREIGN", "CONSTRAINT") else (re.search(r"FOREIGN KEY \((\w+)\)", ln) or [None, "?"])[1]
                edge(f"tbl:{cur}", f"tbl:{ref.group(1)}", "REFERENCES", "extracted", f"{m}:L{i}",
                     f"{col} ({ref.group(3) or 'default'})")

# policies (final state: later CREATE wins, DROP removes)
policies = {}
for m in mig:
    t = mig_text[m]
    for st in re.finditer(r"(DROP POLICY (?:IF EXISTS )?\"([^\"]+)\" ON ((?:public|storage)\.\w+))|(CREATE POLICY \"([^\"]+)\" ON ((?:public|storage)\.\w+)(.*?);)", t, re.S):
        if st.group(1):
            policies.pop((st.group(3), st.group(2)), None)
        else:
            body = st.group(7)
            cmd = (re.search(r"\bFOR (ALL|SELECT|INSERT|UPDATE|DELETE)", body) or [None, "ALL"])[1]
            policies[(st.group(6), st.group(5))] = (m, line_of(t, st.start()), cmd, body)

# policies created inside DO $$ ... format('CREATE POLICY "%s_x" ON public.%I FOR cmd ... USING (...)') loops
for m in mig:
    t = mig_text[m]
    for blk in re.finditer(r"DO \$\$.*?\$\$;", t, re.S):
        b = blk.group(0)
        for fp in re.finditer(r"format\('CREATE POLICY \"%s_(\w+)\" ON public\.%I (.*?)', t, t\)", b, re.S):
            arrays = list(re.finditer(r"ARRAY\[([^\]]*)\]", b[:fp.start()], re.S))
            if not arrays:
                continue
            tbls = re.findall(r"'(\w+)'", arrays[-1].group(1))
            body = fp.group(2)
            cmd = (re.search(r"\bFOR (ALL|SELECT|INSERT|UPDATE|DELETE)", body) or [None, "ALL"])[1]
            for tb in tbls:
                if f"tbl:{tb}" in nodes:
                    policies[(f"public.{tb}", f"{tb}_{fp.group(1)}")] = (m, line_of(t, blk.start() + fp.start()), cmd, body)

# SQL functions
sqlfns = {}
for m in mig:
    t = mig_text[m]
    for mt in re.finditer(r"CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\s*\((.*?)(\$\w*\$)(.*?)\3", t, re.S):
        head = t[mt.start():mt.start() + 400]
        sqlfns[mt.group(1)] = (m, line_of(t, mt.start()), "SECURITY DEFINER" in t[mt.start():mt.end() + 200], mt.group(4))
AUTHZ_FN = set(n for n in sqlfns if n.startswith("auth_"))
for name, (m, ln, sd, body) in sqlfns.items():
    layer = "authz" if name in AUTHZ_FN else "database"
    node("sql:" + name, name + "()", layer, "authz" if layer == "authz" else "db-functions", file=f"{m}:L{ln}", ntype="sql_function",
         security_definer=sd)

tb_ref = re.compile(r"(FROM|JOIN|UPDATE|INSERT INTO|DELETE FROM)\s+public\.(\w+)", re.I)
for name, (m, ln, sd, body) in sqlfns.items():
    for mt in tb_ref.finditer(body):
        tn = mt.group(2)
        if f"tbl:{tn}" in nodes:
            rel = "READS" if mt.group(1).upper() in ("FROM", "JOIN") else "WRITES"
            edge("sql:" + name, f"tbl:{tn}", rel, "extracted", f"{m}:L{ln}")
    for mt in re.finditer(r"public\.(\w+)\s*\(", body):
        if mt.group(1) in sqlfns and mt.group(1) != name:
            edge("sql:" + name, "sql:" + mt.group(1), "CALLS", "extracted", f"{m}:L{ln}")

# policy nodes + edges
for (tbl, pname), (m, ln, cmd, body) in policies.items():
    pid = f"pol:{tbl}:{pname}"
    node(pid, pname, "authz", "rls-policy", file=f"{m}:L{ln}", ntype="policy", cmd=cmd)
    tid = "tbl:" + tbl.replace("public.", "")
    if tbl.startswith("storage."):
        node("tbl:storage.objects", "storage.objects", "storage", "storage", ntype="table", file="supabase/migrations/004_storage.sql")
        tid = "tbl:storage.objects"
    if tid in nodes:
        edge(pid, tid, "PROTECTS", "extracted", f"{m}:L{ln}", cmd)
    for mt in re.finditer(r"(?:public\.)?(auth_\w+)\s*\(", body):
        if "sql:" + mt.group(1) in nodes:
            edge(pid, "sql:" + mt.group(1), "USES", "extracted", f"{m}:L{ln}")

# tables with RLS enabled but no policy = reachable only via the service role (confirmed intent for content_plan_shares, client_drive_links)
protected = {e["target"] for e in edges if e["relation"] == "PROTECTS"}
all_sql = "\n".join(mig_text.values())
for nid, n in list(nodes.items()):
    if nid.startswith("tbl:") and nid not in protected and n.get("domain") and re.search(r"ALTER TABLE (?:IF EXISTS )?public\." + re.escape(nid[4:]) + r"\s+ENABLE ROW LEVEL SECURITY", all_sql):
        n["rls_service_only"] = True

# triggers (explicit + DO-loop generated)
for m in mig:
    t = mig_text[m]
    for mt in re.finditer(r"CREATE TRIGGER (\w+)\s+(?:BEFORE|AFTER)[^;]*?ON public\.(\w+)[^;]*?EXECUTE (?:FUNCTION|PROCEDURE) public\.(\w+)", t, re.S):
        tn, tb, fn = mt.groups()
        tid = f"trg:{tn}:{tb}"
        node(tid, tn, "database", "triggers", file=f"{m}:L{line_of(t, mt.start())}", ntype="trigger")
        if f"tbl:{tb}" in nodes:
            edge(tid, f"tbl:{tb}", "FIRES_ON", "extracted", f"{m}:L{line_of(t, mt.start())}")
        if f"sql:{fn}" in nodes:
            edge(tid, f"sql:{fn}", "EXECUTES", "extracted", f"{m}:L{line_of(t, mt.start())}")
    # triggers created in DO $$ loops with format()
    for blk in re.finditer(r"DO \$\$.*?\$\$;", t, re.S):
        b = blk.group(0)
        for ft in re.finditer(r"CREATE TRIGGER (\S+)[^']*?EXECUTE FUNCTION public\.(\w+)", b, re.S):
            fn = ft.group(2)
            arr = re.search(r"ARRAY\[(.*?)\]", b, re.S)
            tbls = re.findall(r"'(\w+)'", arr.group(1)) if arr else []
            for tb in tbls:
                nm = re.sub(r"%\S*?[sI]", tb, ft.group(1)) if "%" in ft.group(1) else ft.group(1)
                if f"tbl:{tb}" in nodes and f"sql:{fn}" in nodes:
                    tid = f"trg:{nm}:{tb}"
                    node(tid, nm, "database", "triggers", file=f"{m}:L{line_of(t, blk.start())}", ntype="trigger")
                    edge(tid, f"tbl:{tb}", "FIRES_ON", "extracted", f"{m}:L{line_of(t, blk.start())}")
                    edge(tid, f"sql:{fn}", "EXECUTES", "extracted", f"{m}:L{line_of(t, blk.start())}")

# 003 creates trg_set_updated_at in a loop over every public table that HAS an updated_at column when 003 runs
# (= tables created in 001, since 003 runs right after 001/002). Reconstruct that set from 001's CREATE TABLE blocks.
t001 = mig_text["supabase/migrations/001_initial_schema.sql"]
for mt in re.finditer(r"CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)\s*\((.*?)\n\);", t001, re.S):
    if "updated_at" in mt.group(2) and "sql:set_updated_at" in nodes:
        tid = f"trg:trg_set_updated_at:{mt.group(1)}"
        node(tid, "trg_set_updated_at", "database", "triggers", ntype="trigger", file="supabase/migrations/003_updated_at.sql (dynamic loop)")
        edge(tid, f"tbl:{mt.group(1)}", "FIRES_ON", "extracted", f"003_updated_at.sql loop + 001_initial_schema.sql:L{line_of(t001, mt.start())} (updated_at column)")
        edge(tid, "sql:set_updated_at", "EXECUTES", "extracted", "supabase/migrations/003_updated_at.sql")

# storage buckets
for bkt in ("task-attachments", "studio-assets", "chat-media"):
    node("bkt:" + bkt, bkt, "storage", "storage", ntype="bucket", file="supabase/migrations/004_storage.sql / 016_chat_v2_private_and_media.sql")

# ------------------------------------------------------------------ Edge Functions
fn_files = {os.path.basename(os.path.dirname(p)): p for p in files("supabase/functions/*/index.ts")}
shared = {os.path.basename(p)[:-3]: p for p in files("supabase/functions/_shared/*.ts")}
OPRE = re.compile(r"\.(select|insert|update|delete|upsert)\(")


def scan_tables(text, src, relpath, quote, label_prefix=""):
    for mt in re.finditer(r"\.from\(\s*" + quote + r"([a-z_\-]+)" + quote + r"\s*\)", text):
        name = mt.group(1)
        tail = text[mt.end():mt.end() + 600].split(";")[0]
        nxt = tail.find(".from(")
        if nxt > 0:
            tail = tail[:nxt]
        ops = set(OPRE.findall(tail)) or {"select"}
        ln = line_of(text, mt.start())
        before = text[max(0, mt.start() - 40):mt.start()]
        if "storage" in before:
            bk = "bkt:" + name
            if bk in nodes:
                edge(src, bk, "STORES_IN", "extracted", f"{relpath}:L{ln}")
            continue
        if f"tbl:{name}" in nodes:
            for op in ops:
                edge(src, f"tbl:{name}", "READS" if op == "select" else "WRITES", "extracted", f"{relpath}:L{ln}", op)


for name, p in fn_files.items():
    t = rd(p)
    node("fn:" + name, name, "backend", "edge-function", file=p, ntype="edge_function", loc=t.count("\n") + 1)
    scan_tables(t, "fn:" + name, p, '"')
    for mt in re.finditer(r"(?:\.rpc\(|rpc\(\s*admin\s*,)\s*\"(\w+)\"", t):
        if "sql:" + mt.group(1) in nodes:
            edge("fn:" + name, "sql:" + mt.group(1), "CALLS", "extracted", f"{p}:L{line_of(t, mt.start())}", "rpc")
    # notify()/audit() (defined in _shared/auth.ts) insert into notifications / audit_logs
    for helper, tbl in (("notify", "notifications"), ("audit", "audit_logs")):
        for mt in re.finditer(r"(?<![\w.])" + helper + r"\(", t):
            if re.match(r"\s*(?:async\s+)?function", t[max(0, mt.start() - 16):mt.start()]):
                continue
            edge("fn:" + name, "tbl:" + tbl, "WRITES", "extracted", f"{p}:L{line_of(t, mt.start())}", f"via {helper}()")
            break
    for mt in re.finditer(r"from \"\.\./_shared/(\w+)\.ts\"", t):
        if mt.group(1) in shared:
            edge("fn:" + name, "shared:" + mt.group(1), "IMPORTS", "extracted", f"{p}:L{line_of(t, mt.start())}")
for name, p in shared.items():
    t = rd(p)
    node("shared:" + name, f"_shared/{name}.ts", "backend", "edge-shared", file=p, ntype="shared_module", loc=t.count("\n") + 1)
    scan_tables(t, "shared:" + name, p, '"')
for src in ("shared:auth",):
    t = rd(shared["auth"])
    if "sendPush" in t:
        edge("shared:auth", "shared:push", "CALLS", "extracted", f"{shared['auth']}:L{line_of(t, t.find('sendPush'))}", "notify() fan-out")

# ------------------------------------------------------------------ Frontend
api_js = rd("js/services/api.js")
FN_BY_KEY = {m.group(1): m.group(2) for m in re.finditer(r"(\w+):\s*\([^)]*\)\s*=>\s*invoke\('([\w\-]+)'", api_js)}
API_MAP = dict(FN_BY_KEY)            # Api.<method> -> edge function
API_ACTION = {}                      # Api.<method> -> action label
for m in re.finditer(r"(\w+):\s*\([^)]*\)\s*=>\s*Api\.(\w+)\('([\w.]+)'", api_js):
    if m.group(2) in FN_BY_KEY:
        API_MAP[m.group(1)] = FN_BY_KEY[m.group(2)]
        API_ACTION[m.group(1)] = m.group(3)
js_files = [p for p in files("js/**/*.js")]


def fe_key(p):
    parts = p.split("/")
    if parts[1] == "modules":
        return "fe:" + parts[2], parts[2], "module"
    if parts[1] == "services":
        return "fe:svc:" + os.path.basename(p)[:-3], "svc/" + os.path.basename(p)[:-3], "service"
    if parts[1] in ("auth", "preview", "permissions", "utils", "ui"):
        return "fe:" + parts[1], parts[1], parts[1]
    return "fe:shell", "shell (app.js, router, config…)", "shell"


fe_files = collections.defaultdict(list)
for p in js_files:
    k, lbl, typ = fe_key(p)
    fe_files[k].append(p)
    t = rd(p)
    n = node(k, "UI · " + lbl, "frontend", typ, ntype="frontend_module")
    n["loc"] = n.get("loc", 0) + t.count("\n") + 1
    n["innerHTML"] = n.get("innerHTML", 0) + t.count("innerHTML")
    n.setdefault("files", []).append(p)
    scan_tables(t, k, p, "'")
    for mt in re.finditer(r"Api\.(\w+)\(\s*(?:'([\w.\-]+)')?", t):
        fnm = API_MAP.get(mt.group(1))
        if fnm and "fn:" + fnm in nodes:
            edge(k, "fn:" + fnm, "CALLS", "extracted", f"{p}:L{line_of(t, mt.start())}", mt.group(2) or API_ACTION.get(mt.group(1)) or mt.group(1))
    for mt in re.finditer(r"table:\s*'(\w+)'", t):
        if "tbl:" + mt.group(1) in nodes:
            edge(k, "tbl:" + mt.group(1), "SUBSCRIBES_TO", "extracted", f"{p}:L{line_of(t, mt.start())}", "realtime")
    for mt in re.finditer(r"STORAGE_BUCKETS\.(TASK_ATTACHMENTS|STUDIO_ASSETS|CHAT_MEDIA)", t):
        b = {"TASK_ATTACHMENTS": "task-attachments", "STUDIO_ASSETS": "studio-assets", "CHAT_MEDIA": "chat-media"}[mt.group(1)]
        edge(k, "bkt:" + b, "STORES_IN", "extracted", f"{p}:L{line_of(t, mt.start())}")
    if re.search(r"storage\s*\.from\(", t) and not any(e["source"] == k and e["relation"] == "STORES_IN" for e in edges):
        pass

# ------------------------------------------------------------------ PHP Kite Drive
php_index, php_file, php_send = rd("integrations/kite-drive/api/index.php"), rd("integrations/kite-drive/file.php"), rd("integrations/kite-drive/api/send.php")
actions = re.findall(r"case '(\w+)':", php_index)
node("php:index", "Kite Drive API (api/index.php)", "external", "kite-drive", ntype="php_api", file="integrations/kite-drive/api/index.php",
     loc=php_index.count("\n") + 1, functions=actions)
node("php:file", "file.php (session-checked file serving)", "external", "kite-drive", ntype="php_script", file="integrations/kite-drive/file.php")
node("php:send", "api/send.php (streaming, thumbnails)", "external", "kite-drive", ntype="php_script", file="integrations/kite-drive/api/send.php")
for tb in ("users", "folders", "files"):
    node("my:" + tb, f"MySQL {tb} (Kite Drive)", "external", "kite-drive", ntype="mysql_table", file="integrations/kite-drive/db.php (NOT IN REPO)")
node("ext:drive-disk", "Hostinger disk: uploads/, _chunks/, _thumbs/, _log/", "storage", "kite-drive", ntype="disk")
for src, text, rp in (("php:index", php_index, "integrations/kite-drive/api/index.php"), ("php:file", php_file, "integrations/kite-drive/file.php")):
    for mt in re.finditer(r"(SELECT[^;'\"]*?FROM|INSERT INTO|UPDATE|DELETE FROM)\s+(users|folders|files)\b", text, re.I | re.S):
        rel = "READS" if mt.group(1).upper().startswith("SELECT") else "WRITES"
        edge(src, "my:" + mt.group(2).lower(), rel, "extracted", f"{rp}:L{line_of(text, mt.start())}")
edge("php:index", "ext:drive-disk", "STORES_IN", "extracted", "integrations/kite-drive/api/index.php: store_file()/rename/unlink")
edge("php:file", "php:send", "CALLS", "extracted", "integrations/kite-drive/file.php: drive_send_file()")
edge("php:index", "php:send", "CALLS", "extracted", "integrations/kite-drive/api/index.php: drive_send_file()/drive_send_thumbnail()")
edge("php:send", "ext:drive-disk", "READS", "extracted", "integrations/kite-drive/api/send.php: drive_resolve_path()")

# ------------------------------------------------------------------ curated actors / external / scheduled (assert-verified)
curated_nodes = [
    ("actor:staff", "Staff users (owner, admins, managers, employees, finance, HR)", "actor", "actors", "Sign in to the SPA; every privilege is derived server-side from user_roles + profiles.employment_status."),
    ("actor:client", "External client reviewer (no login)", "actor", "actors", "Opens a private preview link (preview.html#token) to read a content plan and send feedback/approval."),
    ("actor:drive-client", "Kite Drive legacy client user", "actor", "actors", "Logs into the legacy Drive site; file.php checks their PHP session (legacy code not in repo)."),
    ("actor:cron", "Supabase Dashboard cron (scheduler)", "scheduled", "scheduler", "Daily HTTP calls with x-cron-secret. Configured outside the repo; live state unverified."),
    ("ext:supabase-auth", "Supabase Auth", "authn", "auth", "Issues/validates JWTs (PKCE). getCaller verifies each token with auth.admin.getUser."),
    ("ext:postgrest", "Supabase PostgREST (RLS enforcement point)", "database", "api", "Browser table reads/writes pass through here under the caller's JWT; RLS policies decide."),
    ("ext:realtime", "Supabase Realtime", "backend", "realtime", "Pushes table changes (chat, notifications) to subscribed browsers."),
    ("ext:webpush", "Browser push services (VAPID)", "external", "push", "Third-party services that deliver Web Push payloads."),
    ("ext:vercel", "Vercel static hosting", "external", "hosting", "Serves dist/ built by scripts/build.mjs with CSP/HSTS headers (vercel.json)."),
    ("ext:hostinger", "Hostinger (Apache + PHP + MySQL)", "external", "hosting", "Hosts Kite Drive and optionally the SPA (.htaccess)."),
    ("ext:google-sites", "Google Sites (embedder)", "external", "hosting", "Allowed to frame the SPA via CSP frame-ancestors."),
    ("ext:webrtc", "WebRTC peers + STUN/TURN", "external", "calls", "Peer-to-peer media for calls; ICE_SERVERS from env.js."),
    ("job:due-reminders", "Job: daily task digest", "scheduled", "scheduler", "Runs fn due-reminders; one digest per person per ~20h."),
    ("job:retainer-billing", "Job: daily retainer invoices + overdue marking", "scheduled", "scheduler", "Runs fn retainer-billing -> fin_retainer_generate, fin_mark_overdue."),
    ("job:drive-cleanup", "Job: Drive stale-upload cleanup (_chunks >2 days)", "scheduled", "scheduler", "remove_stale_uploads() in api/index.php; trigger = API usage (call site unconfirmed)."),
    ("sec:sw", "Service worker (sw.js)", "frontend", "pwa", "Offline shell + precache; API traffic bypasses it."),
]
for id, label, layer, mod, purpose in curated_nodes:
    node(id, label, layer, mod, ntype=layer, purpose=purpose, kind="curated")
node("sec:browser-session", "Browser session (localStorage pulse_studio_auth_token)", "authn", "auth", ntype="session", kind="curated",
     purpose="supabase-js persisted PKCE session.", file="js/supabase-client.js")


def has(path, text):
    try:
        return text in rd(path)
    except FileNotFoundError:
        return False


cur_edges = [
    # (src, dst, rel, kind-if-assert-ok, assert (path, text), evidence)
    ("actor:staff", "fe:shell", "USES", ("index.html", "js/app.js"), "index.html loads js/app.js"),
    ("actor:client", "fe:preview", "USES", ("preview.html", "preview"), "preview.html + js/preview/preview.js"),
    ("fe:preview", "fn:client-preview", "CALLS", ("js/preview/preview.js", "client-preview"), "js/preview/preview.js"),
    ("fe:svc:api", "ext:supabase-auth", "AUTHENTICATES", ("js/services/api.js", "getSession"), "js/services/api.js getSession before invoke"),
    ("fe:auth", "ext:supabase-auth", "AUTHENTICATES", ("js/auth/auth-service.js", "signIn"), "js/auth/auth-service.js signIn()"),
    ("ext:supabase-auth", "sec:browser-session", "PUBLISHES", ("js/supabase-client.js", "persistSession: true"), "js/supabase-client.js"),
    ("fe:svc:api", "fn:workflow", "CALLS", ("js/services/api.js", "invoke('workflow'"), "js/services/api.js (generic gateway)"),
    ("shared:auth", "ext:supabase-auth", "AUTHENTICATES", ("supabase/functions/_shared/auth.ts", "admin.auth.getUser"), "_shared/auth.ts getCaller"),
    ("shared:auth", "tbl:notifications", "WRITES", ("supabase/functions/_shared/auth.ts", 'from("notifications").insert'), "_shared/auth.ts notify()"),
    ("shared:auth", "tbl:audit_logs", "WRITES", ("supabase/functions/_shared/auth.ts", 'from("audit_logs").insert'), "_shared/auth.ts audit()"),
    ("shared:push", "ext:webpush", "PUBLISHES", ("supabase/functions/_shared/push.ts", "endpoint"), "_shared/push.ts sendPush"),
    ("fn:kite-drive", "php:index", "CALLS", ("supabase/functions/kite-drive/index.ts", "/api/index.php?action="), "kite-drive/index.ts fetch(KITE_DRIVE_URL/api/index.php)"),
    ("fn:kite-drive", "fe:clients", "SYNCHRONIZES_WITH", ("supabase/functions/kite-drive/index.ts", "signToken"), "kite-drive mints HMAC tokens the browser sends to Drive"),
    ("fe:clients", "php:index", "CALLS", ("js/modules/clients/drive-panel.js", "X-Drive-Token"), "drive-panel.js sends X-Drive-Token directly to Drive"),
    ("php:index", "fn:kite-drive", "AUTHENTICATES", ("integrations/kite-drive/api/index.php", "verify_token"), "PHP verify_token() HMAC with shared secret"),
    ("php:file", "actor:drive-client", "AUTHORIZES", ("integrations/kite-drive/file.php", "isLoggedIn"), "file.php isLoggedIn() + user_id check"),
    ("actor:drive-client", "php:file", "USES", ("integrations/kite-drive/file.php", "isLoggedIn"), "file.php"),
    ("actor:cron", "job:due-reminders", "TRIGGERS", ("supabase/functions/due-reminders/index.ts", "x-cron-secret"), "due-reminders header comment (schedule not in repo)"),
    ("actor:cron", "job:retainer-billing", "TRIGGERS", ("supabase/functions/retainer-billing/index.ts", "x-cron-secret"), "retainer-billing header comment"),
    ("job:due-reminders", "fn:due-reminders", "CALLS", ("supabase/functions/due-reminders/index.ts", "CRON_SECRET"), "function itself"),
    ("job:retainer-billing", "fn:retainer-billing", "CALLS", ("supabase/functions/retainer-billing/index.ts", "CRON_SECRET"), "function itself"),
    ("job:drive-cleanup", "ext:drive-disk", "WRITES", ("integrations/kite-drive/api/index.php", "remove_stale_uploads"), "api/index.php remove_stale_uploads()"),
    ("fn:client-preview", "bkt:studio-assets", "READS", ("supabase/functions/client-preview/index.ts", "createSignedUrls"), "client-preview signed URLs (1h)"),
    ("ext:vercel", "fe:shell", "USES", ("vercel.json", "outputDirectory"), "vercel.json outputDirectory dist"),
    ("ext:hostinger", "php:index", "USES", ("integrations/kite-drive/api/.htaccess", "index.php"), "Hostinger serves Drive PHP"),
    ("ext:google-sites", "fe:shell", "USES", ("vercel.json", "sites.google.com"), "CSP frame-ancestors allows sites.google.com"),
    ("fe:svc:call-service", "ext:webrtc", "CALLS", ("js/services/call-service.js", "RTCPeerConnection"), "call-service.js"),
    ("fe:svc:realtime-service", "ext:realtime", "SUBSCRIBES_TO", ("js/services/realtime-service.js", "channel"), "realtime-service.js"),
    ("fe:svc:push-service", "ext:webpush", "SYNCHRONIZES_WITH", ("js/services/push-service.js", "subscribe"), "push-service.js subscribes; fn workflow push.subscribe stores"),
    ("ext:postgrest", "sql:auth_is_active", "AUTHORIZES", ("supabase/migrations/002_rls_policies.sql", "auth_is_active"), "RLS predicates call auth_* helper functions"),
    ("fn:retainer-billing", "tbl:notifications", "WRITES", ("supabase/functions/retainer-billing/index.ts", "notify("), "via notify()"),
    ("fn:due-reminders", "tbl:notifications", "WRITES", ("supabase/functions/due-reminders/index.ts", "notify("), "via notify()"),
]
for src, dst, rel, (apath, atext), ev in cur_edges:
    ok = has(apath, atext)
    if src not in nodes or dst not in nodes:
        print("SKIP missing node:", src, dst, file=sys.stderr)
        continue
    edge(src, dst, rel, "curated" if ok else "inferred", ev if ok else ev + f" [ASSERT FAILED: '{atext}' not in {apath}]")

# every browser module reads through PostgREST / Auth boundary (extracted .from() edges); add boundary edges
for k in [k for k in nodes if k.startswith("fe:") and any(e["source"] == k and e["relation"] in ("READS", "WRITES") for e in edges)]:
    edge(k, "ext:postgrest", "CALLS", "curated", "js/** .from('<table>') via supabase-js (see READS/WRITES edges)")

# ------------------------------------------------------------------ purposes / responsibilities / issues (curated from audit reading)
PURPOSE = {
    "fn:workflow": ("Task lifecycle, expense/leave decisions, employee update, notification triggers, push subscribe.", "Authenticate (getCaller) -> validate -> authorize (RLS as caller + role rules) -> mutate with service role using conditional updates -> activity log, notify, audit."),
    "fn:chat": ("Channels, DMs, messages, reactions, call ringing.", "Admin-only channel mgmt; staff messaging; author edit/delete; validates members are active staff."),
    "fn:finance": ("Client billing, invoices, payments, retainers.", "Authenticates, checks finance tier, passes whitelisted fields to fin_* SQL functions; browser never sends totals."),
    "fn:kite-drive": ("Decides who may do what with a client's files on Kite Drive and mints HMAC tokens.", "Checks client visibility via RLS as the caller, admin rights for link/upload, signs scoped short-lived tokens, proxies admin actions to the Drive API."),
    "fn:client-preview": ("Public (no JWT) client review of a content plan.", "Share-token lookup, returns presentation fields + signed image URLs, saves feedback/approval, notifies team."),
    "fn:accept-invitation": ("Activates an invited user after password set.", "Requires onboarding status and a pending, unexpired invitation; conditional profile update."),
    "fn:setup-admin": ("One-time bootstrap of the first super admin.", "SETUP_TOKEN gate, atomic lock row, rollback on failure; delete after use."),
    "fn:due-reminders": ("Daily overdue/due-today/due-tomorrow digest.", "CRON_SECRET gate; idempotent via 20h per-user guard; notify() + push."),
    "fn:retainer-billing": ("Daily retainer draft invoices and overdue marking.", "CRON_SECRET gate; fin_retainer_generate + fin_mark_overdue; notifies finance."),
    "fn:broadcast": ("Announcements to audiences with an hourly rate limit.", "Not read in detail (grep only)."),
    "fn:content-plan": ("Content plan operations.", "NOT READ."),
    "fn:invite-employee": ("Invites/deletes employees.", "NOT READ."),
    "shared:auth": ("Shared identity + helper layer for all Edge Functions.", "getCaller (JWT -> roles/status), adminClient (service role), userClient (RLS as caller), notify(), audit(), userIdsWithRoles()."),
    "shared:http": ("Shared HTTP wrapper.", "serveJson (CORS allow-list from ALLOWED_ORIGINS, POST-only, error masking), readJson."),
    "shared:push": ("Web Push sender.", "NOT READ in detail; includes isAllowedPushEndpoint guard."),
    "shared:validate": ("Input validators.", "NOT READ."),
    "php:index": ("Kite Drive API: browse/manage/upload files for a Drive client.", "Verifies HMAC token (aud, exp, scope, client binding), scopes every query to user_id=cid, chunked uploads, zip, thumbnails, audit log file."),
    "php:file": ("Serves /uploads/* behind a login check.", "Legacy PHP session; clients open only their own files, admins need view/download permission."),
    "php:send": ("Streaming/thumbnail helpers.", "realpath-confined path resolution, Range support, inline only for safe MIME, SVG sandboxed."),
    "fe:svc:api": ("Single gateway to Edge Functions.", "invoke(name, body): refreshes session, posts JSON with JWT; Api.* wrappers."),
    "fe:shell": ("SPA shell: app.js, router, config, PWA, supabase-client.", "getSupabase() singleton (118 call edges in graph) is the data-access gateway."),
    "fe:preview": ("Public client-review page.", "Token in URL fragment; calls client-preview."),
    "fe:permissions": ("Client-side role gating.", "UX only - not an enforcement point (role lists duplicated, ARC-01)."),
    "fe:clients": ("Clients, Client Hub, Drive panel (files).", "DrivePanel calls kite-drive for tokens and the Drive API directly."),
    "fe:campaigns": ("Campaigns and content-plan editor/PPTX export.", "ContentPlanEditor (1094 lines) uploads visuals to studio-assets."),
    "fe:tasks": ("Task board/UI.", "Browser has SELECT-only on tasks; mutations go through workflow."),
    "fe:chat": ("Chat UI.", "ChatModule 1194 lines, 59 graph edges (God-class candidate)."),
    "fe:finance": ("Finance UI tabs.", "Calls finance function; direct expenses insert (finance.js:318)."),
    "fe:hr": ("HR UI.", "Direct leave_requests insert (hr.js:549), then workflow notification."),
    "sql:auth_is_owner": ("RLS predicate: super_admin/owner/ceo.", "Owner-only money data (migration 015)."),
    "sql:auth_is_admin": ("RLS predicate: super_admin/owner/general_manager.", "Admin tier (migration 002)."),
    "sql:auth_is_finance": ("RLS predicate: owner tier + finance_manager + accountant.", "Finance read access (migration 017)."),
    "sql:auth_can_see_client": ("RLS predicate: client visible by owner, account manager/creator, or department.", "Department scoping (migration 015); also used by Edge Functions through userClient."),
    "tbl:money_figures": ("Owner-only money amounts (polymorphic entity/entity_id).", "Replaces legacy budget/value columns, which a trigger blanks."),
    "tbl:client_drive_links": ("Client -> Kite Drive account link.", "RLS on, no policies, no grants: service role only."),
    "tbl:invoices": ("Invoices (frozen once issued).", "Writes only via fin_* functions; delete blocked; audited."),
    "tbl:content_plan_shares": ("Public share tokens for content plans.", "Looked up by client-preview with service role."),
    "tbl:profiles": ("Identity, HR and hierarchy data.", "Column-level GRANTs; employment_status gates privileges."),
    "tbl:notifications": ("In-app notifications.", "Written by notify() (service role)."),
    "tbl:audit_logs": ("Audit trail for Edge actions.", "Insert failures are logged and swallowed."),
}
ISSUES = {
    "fn:client-preview": ["SEC-01"], "php:index": ["SEC-02", "OPS-03"], "fn:kite-drive": ["DAT-01"], "tbl:client_drive_links": ["DAT-01"],
    "shared:auth": ["ARC-01", "OPS-01"], "fe:permissions": ["ARC-01"], "sql:auth_is_admin": ["ARC-01"], "sql:auth_is_owner": ["ARC-01"],
    "sql:auth_is_finance": ["ARC-01"], "job:due-reminders": ["OPS-01"], "job:retainer-billing": ["OPS-01"], "actor:cron": ["OPS-01"],
    "tbl:money_figures": ["DAT-02"], "fn:workflow": ["SEC-03"], "shared:http": ["SEC-04"], "fe:hr": ["SEC-05"], "fe:tasks": ["SEC-05"],
    "fe:projects": ["SEC-05"], "fe:reports": ["SEC-05"], "tbl:clients": ["DAT-03"], "tbl:invoices": ["DAT-03"], "job:drive-cleanup": ["OPS-03"],
}
# documentation-vs-code discrepancies, computed (not hand-listed)
db_doc = rd("docs/database.md")
UNDOC = sorted(t for t in tables if not re.search(r"\b" + re.escape(t) + r"\b", db_doc))
for t in UNDOC:
    ISSUES.setdefault("tbl:" + t, []).append("DOC-01")
for nid in list(nodes):
    if nodes[nid].get("ntype") == "trigger":
        ISSUES.setdefault(nid, []).append("DOC-02")
for nid in ("sql:set_updated_at", "sql:blank_money_columns", "sql:content_posts_guard", "sql:fin_invoice_guard", "sql:fin_payment_guard", "sql:fin_item_calc", "sql:fin_audit"):
    if nid in nodes:
        ISSUES.setdefault(nid, []).append("DOC-02")
print("tables not mentioned in docs/database.md:", len(UNDOC), "of", len(tables), file=sys.stderr)
SECBOUNDARY = {
    "frontend": "Untrusted: runs in the user's browser; CSP script-src 'self'; never trusted for roles.",
    "backend": "Trusted: verifies JWT server-side, derives roles from DB, uses service role only after authorization.",
    "authz": "Enforcement: RLS predicates / SECURITY DEFINER helper functions (search_path pinned).",
    "database": "Trusted data tier; anon revoked; writes limited by grants + policies + triggers.",
    "authn": "Identity provider boundary.",
    "external": "Separate trust domain (own secrets / sessions).",
    "storage": "Private buckets / Drive disk; access via signed URLs or token-checked PHP.",
    "scheduled": "Secret-gated (CRON_SECRET); no user JWT.",
    "actor": "Principal.",
}
for nid, n in nodes.items():
    if nid in PURPOSE:
        n["purpose"], n["responsibility"] = PURPOSE[nid]
        n["purpose_conf"] = "curated"
    elif n.get("ntype") == "table":
        n["purpose"] = f"{n.get('domain', 'other')} domain table (purpose inferred from name/migration only)"
        n["purpose_conf"] = "inferred"
    elif n.get("ntype") == "policy":
        n["purpose"] = f"RLS policy ({n.get('cmd')}) on {nid.split(':')[1]}"
        n["purpose_conf"] = "extracted"
    elif n.get("ntype") == "trigger":
        n["purpose"] = "Database trigger"
        n["purpose_conf"] = "extracted"
    elif "purpose" not in n:
        n["purpose"] = {"frontend_module": "Browser feature module (not read line by line; relationships extracted from source)"}.get(n.get("ntype"), "")
        n["purpose_conf"] = "inferred" if n["purpose"] else ""
    n["issues"] = ISSUES.get(nid, [])
    n["security_boundary"] = SECBOUNDARY.get(n["layer"], "")
    if n.get("rls_service_only"):
        n["security_boundary"] = "RLS enabled with NO policies: browser roles cannot read or write; reachable only through the service role (Edge Functions)."

# ------------------------------------------------------------------ Graphify link
gj = json.load(open(GRAPHIFY_JSON, encoding="utf8"))
G = {n["id"]: n for n in gj["nodes"]}
by_file = collections.defaultdict(list)
for n in G.values():
    by_file[n.get("source_file")].append(n)
contains = collections.Counter()
for e in gj.get("links") or gj.get("edges"):
    pass
for nid, n in nodes.items():
    fl = n.get("files") or ([n["file"].split(":")[0]] if n.get("file") and ":" in n["file"] else [n.get("file")] if n.get("file") else [])
    gn = [x for f in fl for x in by_file.get(f, [])]
    if gn:
        n["graphify"] = {"files": fl, "symbols": len(gn), "community": sorted({x.get("community") for x in gn if x.get("community") is not None})[:6],
                         "example_ids": [x["id"] for x in gn[:3]]}
        n["functions"] = n.get("functions") or [x.get("label") for x in gn if x.get("label", "").endswith("()")][:12]

# ------------------------------------------------------------------ layout grouping (business domain band) - presentation only
FE_GROUP = {"tasks": "tasks", "projects": "projects", "campaigns": "content", "clients": "clients", "crm": "clients", "employees": "identity", "hr": "hr",
            "departments": "identity", "admin": "identity", "auth": "identity", "finance": "finance", "chat": "comms", "broadcast": "comms",
            "calendar": "tasks", "documents": "tasks", "dashboard": "platform", "reports": "platform", "qr": "platform", "preview": "content", "permissions": "identity"}
FN_GROUP = {"workflow": "tasks", "chat": "comms", "finance": "finance", "kite-drive": "clients", "client-preview": "content", "content-plan": "content",
            "accept-invitation": "identity", "invite-employee": "identity", "setup-admin": "identity", "broadcast": "comms", "due-reminders": "tasks",
            "retainer-billing": "finance"}
for nid, n in nodes.items():
    g = "platform"
    if nid.startswith("tbl:"):
        g = DOMAIN.get(nid[4:], "platform")
    elif nid.startswith("fe:") and nid[3:] in FE_GROUP:
        g = FE_GROUP[nid[3:]]
    elif nid.startswith("fn:"):
        g = FN_GROUP.get(nid[3:], "platform")
    elif nid.startswith("sql:fin_") or nid.startswith("job:retainer"):
        g = "finance"
    elif nid.startswith("sql:auth_"):
        g = "identity"
    elif nid.startswith("job:due"):
        g = "tasks"
    elif nid.startswith("bkt:"):
        g = {"task-attachments": "tasks", "studio-assets": "content", "chat-media": "comms"}[nid[4:]]
    elif nid.startswith("php:") or nid.startswith("my:") or nid == "ext:drive-disk" or nid in ("actor:drive-client", "job:drive-cleanup"):
        g = "clients"
    elif nid in ("actor:client",):
        g = "content"
    elif nid.startswith("pol:"):
        g = DOMAIN.get(nid.split(":")[1], "platform")
    elif nid.startswith("trg:"):
        g = DOMAIN.get(nid.split(":")[-1], "platform")
    n["group"] = g

# ------------------------------------------------------------------ degrees / criticality
deg = collections.Counter()
for e in edges:
    deg[e["source"]] += 1
    deg[e["target"]] += 1
for nid, n in nodes.items():
    n["degree"] = deg[nid]
CRIT = {"shared:auth", "fe:shell", "fe:svc:api", "ext:supabase-auth", "ext:postgrest", "sql:auth_can_see_client", "sql:auth_is_owner", "php:index", "fn:kite-drive", "tbl:profiles", "tbl:user_roles"}
top = {nid for nid, _ in deg.most_common(12) if nodes[nid]["layer"] not in ("authz",) or nodes[nid].get("ntype") != "policy"}
for nid, n in nodes.items():
    n["critical"] = nid in CRIT or nid in top

# ------------------------------------------------------------------ Graph C: workflows (steps reference node ids; validated)
WF = {
    "Employee invitation to activation": [
        ("actor:staff", "fn:invite-employee", "admin invites (function not read in detail)", "inferred"),
        ("fe:auth", "ext:supabase-auth", "user sets password (PKCE session)", "curated"),
        ("fe:auth", "fn:accept-invitation", "Api.acceptInvitation()", "extracted"),
        ("fn:accept-invitation", "shared:auth", "getCaller: JWT -> profile+roles", "extracted"),
        ("fn:accept-invitation", "tbl:invitations", "reads pending invitation; marks accepted/expired", "extracted"),
        ("fn:accept-invitation", "tbl:profiles", "conditional update onboarding -> active", "extracted"),
        ("fn:accept-invitation", "tbl:notifications", "notify admins + HR", "extracted"),
    ],
    "Task status change": [
        ("fe:tasks", "fn:workflow", "Api.workflow('task.set_status')", "extracted"),
        ("fn:workflow", "shared:auth", "getCaller + requireStaff", "extracted"),
        ("fn:workflow", "tbl:tasks", "loads task as caller (RLS) then conditional update", "extracted"),
        ("fn:workflow", "tbl:task_activity_logs", "activity log", "extracted"),
        ("fn:workflow", "tbl:notifications", "notify participants", "extracted"),
        ("fn:workflow", "tbl:audit_logs", "audit", "extracted"),
    ],
    "Expense and leave approval": [
        ("fe:finance", "tbl:expenses", "browser INSERT under RLS (finance.js)", "extracted"),
        ("fe:hr", "tbl:leave_requests", "browser INSERT under RLS (hr.js)", "extracted"),
        ("fe:finance", "fn:workflow", "expense.submitted / expense.decide", "extracted"),
        ("fe:hr", "fn:workflow", "leave.submitted / leave.decide", "extracted"),
        ("fn:workflow", "tbl:expense_approvals", "records approval decision", "extracted"),
        ("fn:workflow", "tbl:notifications", "notify approvers / submitter", "extracted"),
    ],
    "Invoice lifecycle (finance)": [
        ("fe:finance", "fn:finance", "Api.finance('invoice.save|issue|void', 'payment.add|reverse')", "extracted"),
        ("fn:finance", "shared:auth", "getCaller + finance-tier check", "extracted"),
        ("fn:finance", "sql:fin_invoice_save", "rpc: server-side NUMERIC totals", "extracted"),
        ("fn:finance", "sql:fin_invoice_issue", "rpc: gapless number, freeze", "extracted"),
        ("fn:finance", "sql:fin_payment_add", "rpc: row lock + status refresh", "extracted"),
        ("sql:fin_invoice_issue", "tbl:invoices", "writes (FOR UPDATE)", "extracted"),
        ("sql:fin_payment_add", "tbl:invoice_payments", "writes", "extracted"),
    ],
    "Retainer billing (scheduled)": [
        ("actor:cron", "job:retainer-billing", "daily trigger with x-cron-secret", "curated"),
        ("job:retainer-billing", "fn:retainer-billing", "HTTP call", "curated"),
        ("fn:retainer-billing", "sql:fin_retainer_generate", "rpc: monthly draft invoices", "extracted"),
        ("fn:retainer-billing", "sql:fin_mark_overdue", "rpc: mark overdue", "extracted"),
        ("fn:retainer-billing", "tbl:notifications", "notify finance people", "curated"),
    ],
    "Client content approval": [
        ("actor:client", "fe:preview", "opens preview.html#token", "curated"),
        ("fe:preview", "fn:client-preview", "get / feedback / approve_all", "curated"),
        ("fn:client-preview", "tbl:content_plan_shares", "token lookup (service role)", "extracted"),
        ("fn:client-preview", "bkt:studio-assets", "signed image URLs (1h)", "curated"),
        ("fn:client-preview", "tbl:content_feedback", "insert feedback", "extracted"),
        ("fn:client-preview", "tbl:content_plans", "status approved / changes_requested", "extracted"),
        ("fn:client-preview", "tbl:notifications", "notify admins, creator, publisher (+push)", "extracted"),
    ],
    "Kite Drive file access": [
        ("fe:clients", "fn:kite-drive", "Api.kiteDrive('token')", "extracted"),
        ("fn:kite-drive", "shared:auth", "getCaller + requireStaff", "extracted"),
        ("fn:kite-drive", "tbl:clients", "visibility check as caller (RLS)", "extracted"),
        ("fn:kite-drive", "tbl:client_drive_links", "resolve Drive user id", "extracted"),
        ("fn:kite-drive", "fe:clients", "returns HMAC token (<=30 min)", "curated"),
        ("fe:clients", "php:index", "X-Drive-Token request", "curated"),
        ("php:index", "my:files", "queries scoped to user_id = token cid", "extracted"),
        ("php:index", "ext:drive-disk", "streams / stores file bytes", "extracted"),
    ],
    "Notifications and push": [
        ("shared:auth", "tbl:notifications", "notify(): insert row", "extracted"),
        ("shared:auth", "shared:push", "sendPush()", "extracted"),
        ("shared:push", "ext:webpush", "VAPID push", "curated"),
        ("tbl:notifications", "ext:realtime", "table changes", "inferred"),
        ("ext:realtime", "fe:svc:realtime-service", "subscribed browser", "curated"),
    ],
}
def has_edge(a, b):
    return any((e["source"] == a and e["target"] == b) or (e["source"] == b and e["target"] == a) for e in edges)


workflows = []
for name, steps in WF.items():
    out = []
    for i, (s, d, label, kind) in enumerate(steps, 1):
        if s not in nodes or d not in nodes:
            print("WF skip", name, s, d, file=sys.stderr)
            continue
        if kind == "extracted" and not has_edge(s, d):
            print(f"WF step claimed extracted but no graph edge: {name} #{i} {s} -> {d}  (downgraded to inferred)", file=sys.stderr)
            kind = "inferred"
        out.append({"n": i, "from": s, "to": d, "label": label, "kind": kind})
    workflows.append({"name": name, "steps": out})

# drop empty-label nodes with no edges (e.g. unused helper functions are kept: they are real)
data = {
    "meta": {"repo": "pulse-studio-os", "generated_from": "repository sources (regex extraction + audit-curated edges)", "date": "2026-11-06",
             "counts": {"nodes": len(nodes), "edges": len(edges)},
             "edge_kinds": collections.Counter(e["kind"] for e in edges),
             "limitations": ["Browser modules were not read line by line; their DB/API edges come from regex over .from()/Api.* call sites.",
                             "PHP SQL edges are regex over SQL strings; Drive db.php/auth.php not in repo.",
                             "RLS policy text is linked to helper functions by name only; policy logic is not evaluated. Policies created by format() loops are parsed only for the CREATE POLICY pattern in 017.",
                             "No runtime evidence. Cron schedules and live schema unverified.",
                             "Notion spec page was empty: no documented-vs-implemented comparison possible."]},
    "nodes": list(nodes.values()), "edges": edges, "workflows": workflows,
}
with open(os.path.join(OUT, "system-graph.json"), "w", encoding="utf8") as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
print("nodes", len(nodes), "edges", len(edges), dict(data["meta"]["edge_kinds"]))
print("layers", dict(collections.Counter(n["layer"] for n in nodes.values())))
print("rel", dict(collections.Counter(e["relation"] for e in edges)))
failed = [e for e in edges if "ASSERT FAILED" in e["evidence"][0]]
print("assert-failed edges:", len(failed))
for e in failed:
    print("  ", e["source"], e["relation"], e["target"], e["evidence"][0])
