#!/usr/bin/env python3
"""Embeds system-graph.json into viewer_template.html -> system-architecture.html (self-contained, no network)."""
import os, json
D = os.path.join(os.getcwd(), "docs/system-architecture-audit/system-graph")
data = open(os.path.join(D, "system-graph.json"), encoding="utf8").read()
tpl = open(os.path.join(D, "viewer_template.html"), encoding="utf8").read()
out = tpl.replace("__DATA__", data.replace("</", "<\\/"))
open(os.path.join(D, "system-architecture.html"), "w", encoding="utf8").write(out)
print("wrote system-architecture.html", len(out) // 1024, "KB")
