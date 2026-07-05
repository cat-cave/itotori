; kaifuu-kag-synthetic-corpus — 02-choices.ks
; SPDX-License-Identifier: CC0-1.0
; Original, hand-authored CC0 KAG (.ks) content. Contains NO copyrighted game
; text. Authored for itotori KAIFUU-203.
; Covers: a choice menu ([link]...[endlink] captions targeting labels) and a
; [jump] to a label — the label/jump control-flow pair KAIFUU-009 exercises.
*crossroads|Which Lantern First
#Maren
Two lanterns are ready to be lit. Which one should we carry outside?[l]
[link target=*river]Carry the river-blue lantern[endlink][r]
[link target=*amber]Carry the warm amber lantern[endlink][r]

*river|The River-Blue Lantern
#Maren
The blue paper glows like the water at dusk.[p]
[jump target=*outside]

*amber|The Amber Lantern
#Maren
The amber paper glows like a slow evening fire.[p]
[jump target=*outside]

*outside|On the Path
#Maren
We step onto the gravel path, lantern held high.[p]
