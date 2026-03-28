#!/usr/bin/env python3
"""Upload guide WAV/MP3 files to Cloudflare R2."""

import os
import urllib.parse
import urllib.request
import time

OAUTH_TOKEN = "Dri9-KKWweY_cJB8zJxP0MpjwnKSQOw-bMlzTlbZaRo.VqnakYN3WwKOnH5J7QJqz5yAom0Jyz5aFsl2bUkc3dc"
ACCOUNT_ID = "cd975852b081b7b85f3e9a1ea41d2122"
BUCKET = "cinestage-stems"
API_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/r2/buckets/{BUCKET}/objects"

GUIDES_BASE = "/Users/studio/Downloads/Guias: Guides"

FILES_TO_UPLOAD = []

# Song Sections WAV
sections_dir = os.path.join(GUIDES_BASE, "Portugese Guides - 2018", "Song Sections")
for fname in sorted(os.listdir(sections_dir)):
    if fname.startswith(".") or not fname.endswith(".wav"):
        continue
    src = os.path.join(sections_dir, fname)
    key = f"audio/guides/Portugese Guides - 2018/Song Sections/{fname}"
    FILES_TO_UPLOAD.append((src, key, "audio/wav"))

# Dynamic Cues WAV
dynamic_dir = os.path.join(GUIDES_BASE, "Portugese Guides - 2018", "Dynamic Cues")
for fname in sorted(os.listdir(dynamic_dir)):
    if fname.startswith(".") or not fname.endswith(".wav"):
        continue
    src = os.path.join(dynamic_dir, fname)
    key = f"audio/guides/Portugese Guides - 2018/Dynamic Cues/{fname}"
    FILES_TO_UPLOAD.append((src, key, "audio/wav"))


def upload_file(src, key, mime, retries=3):
    encoded_key = urllib.parse.quote(key, safe="/")
    url = f"{API_BASE}/{encoded_key}"
    with open(src, "rb") as f:
        data = f.read()
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, data=data, method="PUT")
            req.add_header("Authorization", f"Bearer {OAUTH_TOKEN}")
            req.add_header("Content-Type", mime)
            req.add_header("Content-Length", str(len(data)))
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.status
        except Exception as e:
            if attempt < retries:
                print(f"    retry {attempt}/{retries}: {e}")
                time.sleep(2)
            else:
                return f"ERROR: {e}"
    return "ERROR"


total = len(FILES_TO_UPLOAD)
ok = fail = 0

for i, (src, key, mime) in enumerate(FILES_TO_UPLOAD, 1):
    name = os.path.basename(src)
    size = os.path.getsize(src)
    print(f"  [{i}/{total}] {name} ({size//1024}KB) ...", end=" ", flush=True)
    result = upload_file(src, key, mime)
    if result in (200, 201):
        print(f"✓")
        ok += 1
    else:
        print(f"✗ {result}")
        fail += 1

print(f"\nDone. {ok} uploaded, {fail} failed.")
