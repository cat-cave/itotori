; Synthetic KAG .ks fixture (CC0, authored) — constructs OUTSIDE the supported
; macro/storage subset. Every construct below MUST surface as a typed semantic
; diagnostic (not a crash, not a silent skip, not a faked value). Plain text
; still replays around them.
*start
Plain narration replays fine.
[eval exp="f.score = f.score * 2"]
[emb exp="f.a + f.b"]
[if exp="f.flag == 1"]
Conditional body text.
[endif]
[iscript]
// This is TJS, not KAG. It must be swallowed whole.
var x = 10;
f.total = x * 2;
[endscript]
[erasemacro name="greet"]
[jump storage="other_scene.ks" target=*elsewhere]
[unknownwidget mode=fancy]
Narration after the diagnostics.
