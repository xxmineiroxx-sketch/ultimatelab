#!/bin/bash
# seed-cloudflare-kv.sh
# Pushes all existing sync data from UltimateSyncServer/store.json into Cloudflare KV.
#
# Usage:
#   1. Replace KV_NAMESPACE_ID below with your actual ID (from wrangler.toml)
#   2. Run: bash scripts/seed-cloudflare-kv.sh
#
# Prerequisites:
#   npm install -g wrangler
#   wrangler login

set -e

KV_NAMESPACE_ID="REPLACE_WITH_KV_NAMESPACE_ID"
STORE_FILE="$HOME/Desktop/Ultimate_Workspace/UltimateSyncServer/store.json"
WRANGLER="npx wrangler"

if [ ! -f "$STORE_FILE" ]; then
  echo "❌ store.json not found at $STORE_FILE"
  exit 1
fi

echo "📦 Reading store.json..."

python3 << PYEOF
import json, subprocess, sys

with open("$STORE_FILE") as f:
    store = json.load(f)

kv_id = "$KV_NAMESPACE_ID"

def kv_put(key, value):
    data = json.dumps(value)
    result = subprocess.run(
        ["npx", "wrangler", "kv:key", "put", "--namespace-id", kv_id, key, data],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  ⚠️  Failed to write {key}: {result.stderr.strip()}")
    else:
        print(f"  ✅ {key}")

# songLibrary
songs = store.get("songLibrary", {})
print(f"📤 Uploading songLibrary ({len(songs)} songs)...")
kv_put("songLibrary", songs)

# people
people = store.get("people", [])
print(f"📤 Uploading people ({len(people)})...")
kv_put("people", people)

# services
services = store.get("services", [])
print(f"📤 Uploading services ({len(services)})...")
kv_put("services", services)

# plans
plans = store.get("plans", {})
print(f"📤 Uploading plans ({len(plans)})...")
kv_put("plans", plans)

# vocalAssignments
vocals = store.get("vocalAssignments", {})
print(f"📤 Uploading vocalAssignments ({len(vocals)} services)...")
kv_put("vocalAssignments", vocals)

# blockouts
blockouts = store.get("blockouts", [])
print(f"📤 Uploading blockouts ({len(blockouts)})...")
kv_put("blockouts", blockouts)

print("\n✅ All data seeded to Cloudflare KV!")
PYEOF
