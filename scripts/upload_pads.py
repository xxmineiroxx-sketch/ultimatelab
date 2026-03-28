#!/usr/bin/env python3
"""Upload pad MP3 files to Cloudflare R2 using the CF API (handles # in filenames)."""

import os
import sys
import urllib.parse
import urllib.request
import time

OAUTH_TOKEN = "Dri9-KKWweY_cJB8zJxP0MpjwnKSQOw-bMlzTlbZaRo.VqnakYN3WwKOnH5J7QJqz5yAom0Jyz5aFsl2bUkc3dc"
ACCOUNT_ID = "cd975852b081b7b85f3e9a1ea41d2122"
BUCKET = "cinestage-stems"
API_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/r2/buckets/{BUCKET}/objects"

PADS_BASE = "/Users/studio/Downloads/PADS"
NOTES = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"]

FILES_TO_UPLOAD = []

# Vol 1
for note in NOTES:
    src = os.path.join(PADS_BASE, "MONTION PADS - ABEL MENDONZA", "Motion Pads Vol 1", f"{note}-PAD.mp3")
    key = f"audio/pads/MONTION PADS - ABEL MENDONZA/Motion Pads Vol 1/{note}-PAD.mp3"
    FILES_TO_UPLOAD.append((src, key))

# Vol 2
for note in NOTES:
    src = os.path.join(PADS_BASE, "Motion Pads Vol 2 MP3", f"{note} Pad.mp3")
    key = f"audio/pads/Motion Pads Vol 2 MP3/{note} Pad.mp3"
    FILES_TO_UPLOAD.append((src, key))

# Vol 3 (nested dir)
for note in NOTES:
    src = os.path.join(PADS_BASE, "Motion Pads Vol 3 MP3", "Motion Pads Vol 3 MP3", f"{note} Pad.mp3")
    key = f"audio/pads/Motion Pads Vol 3 MP3/{note} Pad.mp3"
    FILES_TO_UPLOAD.append((src, key))


def upload_file(src, key, retries=3):
    encoded_key = urllib.parse.quote(key, safe="/")
    url = f"{API_BASE}/{encoded_key}"
    with open(src, "rb") as f:
        data = f.read()
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, data=data, method="PUT")
            req.add_header("Authorization", f"Bearer {OAUTH_TOKEN}")
            req.add_header("Content-Type", "audio/mpeg")
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
ok = 0
fail = 0

for i, (src, key) in enumerate(FILES_TO_UPLOAD, 1):
    name = os.path.basename(src)
    if not os.path.exists(src):
        print(f"  [{i}/{total}] SKIP (no file): {name}")
        continue
    print(f"  [{i}/{total}] {key} ...", end=" ", flush=True)
    result = upload_file(src, key)
    if result in (200, 201):
        print(f"✓ ({result})")
        ok += 1
    else:
        print(f"✗ {result}")
        fail += 1

print(f"\nDone. {ok} uploaded, {fail} failed.")
