#!/usr/bin/env python3
"""Build the RFID detector app for each firmware family into apps/, with apps/manifest.json for the page, and copy
the app's tools/flipper_crystal.py here: the copy in the app's repository is the one to edit.

    python3 build_apps.py /path/to/flipperzero-good-faps/nfc_rfid_detector \\
        Official=/path/to/ufbt-home-official Momentum=/path/to/ufbt-home-momentum

Each argument after the source is FORK=UFBT_HOME, FORK being what the Flipper reports as firmware.origin.fork.
Make the homes once with ufbt:

    UFBT_HOME=<dir> ufbt update --channel=release
    UFBT_HOME=<dir> ufbt update --index-url=https://up.momentum-fw.dev/firmware/directory.json --channel=release

A build loads on firmware of the same fork whose API has the same major and an equal or newer minor; the page picks
by those (flipper.js pickBuild). Builds are only a stopgap until the app is in each firmware's own catalog.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
APPS = os.path.join(HERE, "apps")
# the name each fork ships the app under, so an install from the page keeps it
NAMES = {"Momentum": "NFC/RFID Detector"}


def api_of(home):
    with open(os.path.join(home, "current/sdk_headers/f7_sdk/targets/f7/api_symbols.csv")) as f:
        for line in f:
            if line.startswith("Version,"):
                major, minor = line.split(",")[2].split(".")
                return [int(major), int(minor)]
    raise SystemExit(f"{home}: no API version in the SDK")


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    src = os.path.abspath(sys.argv[1])
    fam = open(os.path.join(src, "application.fam")).read()
    appid = re.search(r'appid="([^"]+)"', fam).group(1)
    version = re.search(r'fap_version="([^"]+)"', fam).group(1)
    commit = subprocess.run(["git", "-C", src, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", src, "status", "--porcelain", "."], capture_output=True, text=True).stdout.strip()
    if dirty:
        raise SystemExit(f"{src} has uncommitted changes: commit first, so each build names its source")

    os.makedirs(APPS, exist_ok=True)
    manifest = []
    for arg in sys.argv[2:]:
        fork, home = arg.split("=", 1)
        home = os.path.abspath(home)
        state = json.load(open(os.path.join(home, "current/ufbt_state.json")))
        api = api_of(home)
        print(f"{fork}: SDK {state.get('version')} (API {api[0]}.{api[1]})", flush=True)
        name = f"{appid}-{fork.lower()}-{api[0]}.{api[1]}.fap"
        with tempfile.TemporaryDirectory() as tmp:
            build = os.path.join(tmp, appid)
            shutil.copytree(src, build, ignore=shutil.ignore_patterns("dist", ".vscode"))
            if fork in NAMES:
                with open(os.path.join(build, "application.fam"), "w") as f:
                    f.write(re.sub(r'name="[^"]*"', f'name="{NAMES[fork]}"', fam, count=1))
            subprocess.run(["ufbt"], cwd=build, env={**os.environ, "UFBT_HOME": home}, check=True, stdout=subprocess.DEVNULL)
            shutil.copyfile(os.path.join(build, "dist", f"{appid}.fap"), os.path.join(APPS, name))
        # the page recognises an installed build by its MD5 (`storage md5` on the Flipper)
        with open(os.path.join(APPS, name), "rb") as f:
            md5 = hashlib.md5(f.read()).hexdigest()
        manifest.append({"fork": fork, "label": f"{fork} firmware ({state.get('version')})", "api": api,
                         "file": name, "version": version, "source": commit, "sdk": state.get("version"), "md5": md5})
    # the script ships with the app (tools/); the page serves that same copy
    shutil.copyfile(os.path.join(src, "tools", "flipper_crystal.py"), os.path.join(HERE, "flipper_crystal.py"))
    with open(os.path.join(APPS, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    for m in manifest:
        print(f"  {m['file']}: app {m['version']} ({m['source']}), {m['label']}")


if __name__ == "__main__":
    main()
