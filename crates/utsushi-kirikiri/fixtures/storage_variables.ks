; Synthetic KAG .ks fixture (CC0, authored) — supported storage-variable
; subset: simple f./sf. [eval] assignments (int literal, string literal, a
; bound-variable copy, and a single spaced +/- counter) and a bare-variable
; [emb] read. State is visible as VariableSet/EmbeddedValue events and in the
; final `variables` snapshot; the [emb] read AFTER the increments reflects the
; updated value (2), proving reads see prior writes.
*start
[eval exp="f.count = 0"]
[eval exp="f.count = f.count + 1"]
[eval exp="f.count = f.count + 1"]
The counter reads:
[emb exp="f.count"]
[eval exp='f.name = "Alice"']
[emb exp="f.name"]
[eval exp="sf.copy = f.count"]
Done.
