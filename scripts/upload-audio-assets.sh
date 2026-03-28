#!/bin/bash
# Upload local audio guide and pad files to Cloudflare R2 (cinestage-stems bucket)
# Run from the UltimateMusician_BEST directory

set -e
BUCKET="cinestage-stems"
GUIDES_SRC="/Users/studio/Downloads/Guias: Guides"
PADS_SRC="/Users/studio/Downloads/PADS"
WRANGLER="NODE_TLS_REJECT_UNAUTHORIZED=0 npx wrangler"

echo "🎵 Uploading audio assets to R2 bucket: $BUCKET"
echo ""

upload_file() {
  local src="$1"
  local key="$2"
  local mime="$3"
  echo "  ↑ $key"
  eval "$WRANGLER r2 object put \"$BUCKET/$key\" --file=\"$src\" --content-type=\"$mime\" --remote" 2>/dev/null \
    && echo "    ✓" \
    || echo "    ✗ FAILED: $src"
}

# ── Guides: Portuguese Song Sections (WAV) ─────────────────────────────────
echo "📖 Uploading song section guides..."
while IFS= read -r -d '' file; do
  name=$(basename "$file")
  [[ "$name" == .* ]] && continue
  [[ "$name" != *.wav ]] && continue
  key="audio/guides/Portugese Guides - 2018/Song Sections/$name"
  upload_file "$file" "$key" "audio/wav"
done < <(find "$GUIDES_SRC/Portugese Guides - 2018/Song Sections" -name "*.wav" -print0 2>/dev/null)

# ── Guides: Dynamic Cues (WAV) ─────────────────────────────────────────────
echo "⚡ Uploading dynamic cue guides..."
while IFS= read -r -d '' file; do
  name=$(basename "$file")
  [[ "$name" == .* ]] && continue
  [[ "$name" != *.wav ]] && continue
  key="audio/guides/Portugese Guides - 2018/Dynamic Cues/$name"
  upload_file "$file" "$key" "audio/wav"
done < <(find "$GUIDES_SRC/Portugese Guides - 2018/Dynamic Cues" -name "*.wav" -print0 2>/dev/null)

# ── Guides: Contagem / Count-in (MP3) ─────────────────────────────────────
echo "🔢 Uploading count-in guides..."
while IFS= read -r -d '' file; do
  name=$(basename "$file")
  [[ "$name" == .* ]] && continue
  [[ "$name" != *.mp3 ]] && continue
  key="audio/guides/Contagem/$name"
  upload_file "$file" "$key" "audio/mpeg"
done < <(find "$GUIDES_SRC/Contagem" -name "*.mp3" -print0 2>/dev/null)

# ── Pads: Motion Vol 1 (MP3) ──────────────────────────────────────────────
echo "🎹 Uploading Motion Pads Vol 1..."
while IFS= read -r -d '' file; do
  name=$(basename "$file")
  [[ "$name" == .* ]] && continue
  [[ "$name" != *.mp3 ]] && continue
  key="audio/pads/MONTION PADS - ABEL MENDONZA/Motion Pads Vol 1/$name"
  upload_file "$file" "$key" "audio/mpeg"
done < <(find "$PADS_SRC/MONTION PADS - ABEL MENDONZA/Motion Pads Vol 1" -name "*.mp3" -print0 2>/dev/null)

# ── Pads: Motion Vol 2 (MP3) ──────────────────────────────────────────────
echo "🎹 Uploading Motion Pads Vol 2..."
while IFS= read -r -d '' file; do
  name=$(basename "$file")
  [[ "$name" == .* ]] && continue
  [[ "$name" != *.mp3 ]] && continue
  key="audio/pads/Motion Pads Vol 2 MP3/$name"
  upload_file "$file" "$key" "audio/mpeg"
done < <(find "$PADS_SRC/Motion Pads Vol 2 MP3" -name "*.mp3" -print0 2>/dev/null)

# ── Pads: Motion Vol 3 (MP3) — flatten nested dir ────────────────────────
echo "🎹 Uploading Motion Pads Vol 3..."
while IFS= read -r -d '' file; do
  name=$(basename "$file")
  [[ "$name" == .* ]] && continue
  [[ "$name" != *.mp3 ]] && continue
  key="audio/pads/Motion Pads Vol 3 MP3/$name"
  upload_file "$file" "$key" "audio/mpeg"
done < <(find "$PADS_SRC/Motion Pads Vol 3 MP3" -name "*.mp3" -print0 2>/dev/null)

echo ""
echo "✅ Upload complete!"
