# Bundled render assets

## `DejaVuSans.ttf`

The localized text layer of the headless render pipeline
([`render_pipeline::draw_text`]) rasterises legible mixed-case English
dialogue with this bundled TrueType font. It is compiled into the crate
with `include_bytes!` — there is NO runtime font lookup and NO network
access; the bytes travel with the binary.

- **Family:** DejaVu Sans (regular), version 2.37.
- **Coverage:** full Latin (mixed case, digits, Western punctuation) —
  the legibility requirement for translated English dialogue. It does
  NOT cover CJK; a Japanese source line renders as the font's `.notdef`
  box (tofu), which is why the emitted frame proves the *localized*
  layer rather than the source.
- **License:** the DejaVu Fonts License — a permissive, redistributable
  license derived from the Bitstream Vera Fonts License plus a
  public-domain grant for the DejaVu additions. It permits bundling and
  redistribution (including embedding in software) without royalty; the
  only restriction is that the fonts themselves may not be sold on their
  own and derivative fonts may not use the reserved "DejaVu" name. Neither
  restriction is implicated by embedding the unmodified `.ttf` as a render
  asset. See <https://dejavu-fonts.github.io/License.html>.
