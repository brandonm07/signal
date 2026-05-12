#!/usr/bin/env bash
# Regenerate branded .docx versions of MSA + LOA from the .md sources.
# Requires pandoc. If pandoc isn't installed, downloads a portable binary to /tmp.
#
# Usage:  ./legal/build-docx.sh
#
# Output goes to web/public/legal/*.docx (served on the website)
# and ~/Documents/Signal Advisory/Legal/ (user-facing local copies).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PANDOC=""

# Resolve pandoc
if command -v pandoc >/dev/null 2>&1; then
  PANDOC=$(command -v pandoc)
else
  TMPDIR="/tmp/pandoc-tmp"
  mkdir -p "$TMPDIR"
  if [ ! -x "$TMPDIR/pandoc-3.5-arm64/bin/pandoc" ]; then
    echo "→ Downloading portable pandoc..."
    curl -sL "https://github.com/jgm/pandoc/releases/download/3.5/pandoc-3.5-arm64-macOS.zip" \
      -o "$TMPDIR/pandoc.zip"
    (cd "$TMPDIR" && unzip -q -o pandoc.zip)
  fi
  PANDOC="$TMPDIR/pandoc-3.5-arm64/bin/pandoc"
fi
echo "→ Pandoc: $($PANDOC --version | head -1)"

REF="$REPO/legal/.reference-branded.docx"
LOGO="$REPO/legal/.doc-header-logo.png"

if [ ! -f "$REF" ]; then
  echo "→ Building branded reference.docx..."
  TMPDIR_R=$(mktemp -d)
  "$PANDOC" --print-default-data-file=reference.docx > "$TMPDIR_R/reference.docx"
  (cd "$TMPDIR_R" && unzip -q -o reference.docx)
  python3 - <<PY
import re, os, zipfile
SIGNAL="C9462C"; INK="1A1F24"; MOSS="2F4A3C"
path = "$TMPDIR_R/word/styles.xml"
with open(path) as f: xml = f.read()
def restyle(xml, sid, color):
    pat = re.compile(rf'(<w:style[^>]*w:styleId="{sid}"[^>]*>)(.*?)(</w:style>)', re.DOTALL)
    def sub(m):
        b = m.group(2)
        if 'w:color w:val=' in b:
            b = re.sub(r'w:color w:val="[A-Fa-f0-9]{6}"', f'w:color w:val="{color}"', b, count=1)
        else:
            b = b.replace("</w:rPr>", f'<w:color w:val="{color}"/></w:rPr>', 1)
        return m.group(1) + b + m.group(3)
    return pat.sub(sub, xml)
xml = restyle(xml, "Title", SIGNAL)
xml = restyle(xml, "Heading1", INK)
xml = restyle(xml, "Heading2", SIGNAL)
xml = restyle(xml, "Heading3", MOSS)
with open(path, "w") as f: f.write(xml)
with zipfile.ZipFile("$REF", "w", zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk("$TMPDIR_R"):
        for name in files:
            if name == "reference.docx": continue
            full = os.path.join(root, name)
            arc = os.path.relpath(full, "$TMPDIR_R")
            zf.write(full, arc)
print(f"  wrote {os.path.getsize('$REF')} bytes")
PY
fi

build_one() {
  local SRC="$1"
  local OUT_WEB="$2"
  local OUT_LOCAL="$3"
  local TMP=$(mktemp)
  {
    echo "![Signal Advisory](${LOGO}){width=4.5in}"
    echo ""
    cat "$SRC"
  } > "$TMP"
  "$PANDOC" "$TMP" --reference-doc="$REF" -o "$OUT_WEB"
  cp "$OUT_WEB" "$OUT_LOCAL"
  echo "→ $(basename $OUT_WEB) ($(du -h $OUT_WEB | cut -f1))"
  rm -f "$TMP"
}

USER_DIR="$HOME/Documents/Signal Advisory/Legal"
mkdir -p "$USER_DIR"

build_one "$REPO/legal/MSA-template.md" \
  "$REPO/web/public/legal/signal-advisory-msa-template.docx" \
  "$USER_DIR/Signal Advisory - MSA Template.docx"

build_one "$REPO/legal/LOA-template.md" \
  "$REPO/web/public/legal/signal-advisory-loa-template.docx" \
  "$USER_DIR/Signal Advisory - LOA Template.docx"

# Sync .md copies
cp "$REPO/legal/MSA-template.md" "$REPO/web/public/legal/signal-advisory-msa-template.md"
cp "$REPO/legal/LOA-template.md" "$REPO/web/public/legal/signal-advisory-loa-template.md"
cp "$REPO/legal/MSA-template.md" "$USER_DIR/Signal Advisory - MSA Template.md"
cp "$REPO/legal/LOA-template.md" "$USER_DIR/Signal Advisory - LOA Template.md"

echo "✓ Done. Next: rebuild astro site (pnpm --prefix web run build), commit, push."
