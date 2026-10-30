#!/usr/bin/env python3
"""Stamp each page's scripts and stylesheet with a hash of their contents, so a browser never mixes a new page
with old cached modules (GitHub Pages lets browsers keep a file for 10 minutes).

    python3 stamp_versions.py           # rewrite the pages
    python3 stamp_versions.py --check   # exit 1 if a page is out of date (run before pushing)

Each page gets an import map that sends every local module it loads, imports of imports included, to
"<module>?v=<hash>". The stylesheet link gets the same query. A file's URL changes only when the file does.
"""

import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
IMPORT = re.compile(r"""(?:\bimport\b[^"';]*?\bfrom\s*|\bimport\s*|\bexport\b[^"';]*?\bfrom\s*)["'](\.{1,2}/[^"']+)["']""")
MODULE_SCRIPT = re.compile(r'<script type="module">(.*?)</script>', re.S)
IMPORT_MAP = re.compile(r'\n?( *)<script type="importmap">.*?</script>', re.S)
STYLESHEET = re.compile(r'(<link rel="stylesheet" href=")([^"?]+)(?:\?v=[0-9a-f]+)?(")')


def file_hash(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


def module_graph(page_dir, sources):
    """Every local module reachable from the page's own module scripts, as paths relative to the page."""
    found, pending = set(), []
    for source in sources:
        pending += [os.path.normpath(os.path.join(page_dir, spec)) for spec in IMPORT.findall(source)]
    while pending:
        path = pending.pop()
        if path in found or not os.path.isfile(path):
            continue
        found.add(path)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        pending += [os.path.normpath(os.path.join(os.path.dirname(path), spec)) for spec in IMPORT.findall(text)]
    return sorted(found)


def stamp(page):
    page_dir = os.path.dirname(page)
    with open(page, encoding="utf-8") as f:
        html = f.read()
    stamped = IMPORT_MAP.sub("", html)

    def stamp_stylesheet(match):
        target = os.path.normpath(os.path.join(page_dir, match.group(2)))
        return f"{match.group(1)}{match.group(2)}?v={file_hash(target)}{match.group(3)}"

    stamped = STYLESHEET.sub(stamp_stylesheet, stamped)
    modules = module_graph(page_dir, MODULE_SCRIPT.findall(stamped))
    if modules:
        entries = []
        script = MODULE_SCRIPT.search(stamped)
        indent = re.search(r"( *)<script type=\"module\">", stamped).group(1)
        for path in modules:
            url = os.path.relpath(path, page_dir)
            url = url if url.startswith(".") else "./" + url
            entries.append(f'{indent}      "{url}": "{url}?v={file_hash(path)}"')
        import_map = (
            f'{indent}<script type="importmap">\n{indent}  {{\n{indent}    "imports": {{\n'
            + ",\n".join(entries)
            + f"\n{indent}    }}\n{indent}  }}\n{indent}</script>\n"
        )
        start = stamped.rfind("\n", 0, script.start()) + 1
        stamped = stamped[:start] + import_map + stamped[start:]
    return html, stamped


def main():
    check = "--check" in sys.argv[1:]
    stale = []
    for directory, _, files in os.walk(ROOT):
        if "/." in directory:
            continue
        if "index.html" in files:
            page = os.path.join(directory, "index.html")
            html, stamped = stamp(page)
            if html != stamped:
                stale.append(os.path.relpath(page, ROOT))
                if not check:
                    with open(page, "w", encoding="utf-8") as f:
                        f.write(stamped)
    for page in stale:
        print(("out of date: " if check else "stamped: ") + page)
    return 1 if check and stale else 0


if __name__ == "__main__":
    sys.exit(main())
