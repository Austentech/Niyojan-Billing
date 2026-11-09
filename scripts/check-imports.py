#!/usr/bin/env python3
"""Scan all @/ and relative imports under src/ and report unresolved ones."""
import os, re, sys

ROOT = "/home/z/my-project"
SRC = os.path.join(ROOT, "src")
EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", ".d.ts"]

import_re = re.compile(r"(?:import|export)\s+[^\"';]*?from\s+[\"']([^\"']+)[\"']|import\s*\(\s*[\"']([^\"']+)[\"']\s*\)|require\s*\(\s*[\"']([^\"']+)[\"']\s*\)")
alias_re = re.compile(r"^@/(.*)$")

missing = {}
scanned = 0
for dirpath, dirnames, filenames in os.walk(SRC):
    dirnames[:] = [d for d in dirnames if d not in (".next", "node_modules")]
    for fn in filenames:
        if not fn.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs")):
            continue
        path = os.path.join(dirpath, fn)
        scanned += 1
        try:
            text = open(path, encoding="utf-8").read()
        except Exception:
            continue
        for m in import_re.finditer(text):
            spec = m.group(1) or m.group(2) or m.group(3)
            if not spec or spec.startswith(("http://", "https://", "data:")):
                continue
            # skip bare package imports
            am = alias_re.match(spec)
            if am:
                target = os.path.join(SRC, am.group(1))
            elif spec.startswith("."):
                target = os.path.normpath(os.path.join(os.path.dirname(path), spec))
            else:
                continue  # node_modules package — verified by the bundler
            if not any(os.path.exists(target + e) for e in EXTS):
                missing.setdefault(spec, []).append(os.path.relpath(path, ROOT))

print(f"scanned {scanned} files")
if missing:
    print("MISSING IMPORTS:")
    for spec, files in sorted(missing.items()):
        print(f"  {spec}  <-  {', '.join(sorted(set(files)))}")
    sys.exit(1)
print("All internal imports resolve. No missing modules.")
