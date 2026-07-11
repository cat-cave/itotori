; Synthetic KAG .ks fixture (authored, CC0) — exercises [iscript]…[endscript]
; TJS-block recognition. Every TJS body line below is real KiriKiri script
; code, NOT message text: it MUST be swallowed, never emitted as a `dialogue`
; unit. Ordinary dialogue/speaker lines around the blocks must still parse.
*start
#アリス
これは通常の台詞です。
[iscript]
// TJS source, not KAG. Must be swallowed whole.
f.total = 10;
f.gallery = [
	["cg_01", "cg_01a", "cg_01b"],
	["cg_02", "cg_02a"]
];
if (f.total > 5) f.flag = true;
[endscript]
ブロックの後の地の文。
@iscript
// The @-line-command spelling of the same block.
kag.process("next.ks", "*label");
var s = "これは台詞ではなくコード";
@endscript
#ボブ
別の話者の台詞。
[iscript]f.inline = 1;[endscript]
インライン iscript の後の台詞。
[iscript]
f.first = 1;
[endscript]
[iscript]
f.second = 2;
[endscript]
隣接ブロックの後の地の文。
