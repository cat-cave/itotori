; Synthetic KAG .ks fixture (CC0, authored) — unsupported TJS/macros/commands.
; Every construct below is OUTSIDE the plaintext text/name/choice/jump
; skeleton and MUST surface as a typed semantic diagnostic (not a crash,
; not a silent skip). Plain text still replays around them.
*start
Plain narration replays fine.
[eval exp="f.count = f.count + 1"]
[emb exp="f.playerName"]
[if exp="f.flag == 1"]
Conditional body text.
[endif]
[iscript]
// This is TJS, not KAG. It must be swallowed whole.
var x = 10;
f.total = x * 2;
[endscript]
[macro name="greet"]
Hello from a macro.
[endmacro]
[jump storage="other_scene.ks" target=*elsewhere]
[unknownwidget mode=fancy]
Narration after the diagnostics.
