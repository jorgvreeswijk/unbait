#!/usr/bin/env python3
"""Build the Firefox extension and unsigned ZIP using only the standard library."""

import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def build():
    source = ROOT / "extension"
    output = ROOT / "dist" / "firefox"
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(source, output, ignore=shutil.ignore_patterns(".DS_Store"))

    manifest = json.loads((source / "manifest.json").read_text())
    manifest["background"] = {
        "scripts": ["content/html-utils.js", "background/service-worker.js"]
    }
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": "unbait@erlichmen",
            "strict_min_version": "140.0",
            "data_collection_permissions": {
                "required": ["websiteContent", "browsingActivity", "authenticationInfo"]
            },
        },
        "gecko_android": {"strict_min_version": "142.0"},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    archive = ROOT / "dist" / "unbait-firefox.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
        for file in sorted(output.rglob("*")):
            if file.is_file():
                package.write(file, file.relative_to(output))
    print(f"Firefox extension: {output}")
    print(f"Unsigned package: {archive}")


if __name__ == "__main__":
    build()
