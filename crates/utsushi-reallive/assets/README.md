# Bundled render assets

## `ItotoriJapaneseSubset.otf`

The localized text layer of the headless render pipeline
([`render_pipeline::draw_text`]) rasterises dialogue with this compiled-in
OpenType font. There is no runtime font lookup and no network access: the
bytes travel with the binary.

- **Build:** a modified, standalone JP Regular derivative of face 0 from Noto
  Serif CJK JP 2.003 (`NotoSerifCJK-VF.otf.ttc`). FontTools 4.61.1 first
  subsets the JP face, then instantiates its Regular weight and renames the
  derivative to `Itotori Japanese Subset`; the new name avoids Noto's Reserved
  Font Name requirement for modified OFL fonts.
- **Coverage:** the complete **JIS X 0208** repertoire (its 6,355 kanji plus
  the standard kana, punctuation, Latin, Greek, Cyrillic, and symbols), plus
  printable Latin-1 (`U+0020–007E`, `U+00A0–00FF`) for localized-patch text.
  This is a language standard, not a set derived from renderer inputs, fixtures,
  or staged corpora, so an
  unstaged Japanese title receives the same baseline coverage.
- **Size:** 5,729,292 bytes (5.46 MiB), down from the 57,488,648-byte (55 MiB)
  four-face collection.
- **Provenance:** Adobe/Google's Noto CJK source, Noto Serif CJK JP 2.003.
  The complete redistribution licence is
  [`LICENSE-OFL-1.1.txt`](LICENSE-OFL-1.1.txt).

To reproduce the subset, enumerate every valid JIS X 0208 two-byte cell (for
example, through the standard library's `euc_jp` decoder), add Latin-1, and
pass that text to FontTools against the JP face (index zero). Retain OpenType
layout features, instantiate `wght=400` as a static CFF font, then rename the
family, full, PostScript, and unique names to `Itotori Japanese Subset`. The
checked-in binary is the hermetic runtime asset; this recipe is documentation
only and is never run by the application.
