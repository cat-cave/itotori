; kaifuu-kag-synthetic-corpus — 03-flow.ks
; SPDX-License-Identifier: CC0-1.0
; Original, hand-authored CC0 KAG (.ks) content. Contains NO copyrighted game
; text. Authored for itotori KAIFUU-203.
; Covers: an [if]...[endif] conditional, a [call] into a subroutine label, and
; a [return] back — branching + subroutine control flow.
*gate|The Counting Gate
[eval exp="f.visits = f.visits + 1"]
#Warden
Let me see how many times you have passed through here.[l]
[if exp="f.visits > 1"]
You have walked this path before. Welcome back.[p]
[endif]
[call target=*tally]
#Warden
The count is written in the ledger. You may go on.[p]
[jump target=*gate_done]

*tally|Ledger Tally
#Warden
One more mark in the evening ledger.[p]
[return]

*gate_done|Past the Gate
#Warden
The gate closes softly behind you.[p]
