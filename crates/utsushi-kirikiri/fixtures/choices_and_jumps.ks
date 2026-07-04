; Synthetic KAG .ks fixture (CC0, authored) — choices + jumps.
; Exercises: a same-file @jump, a [link ...]...[endlink] choice menu whose
; two options jump to distinct *labels, and per-branch text. No TJS.
*start|Entry
#Guide
Which path will you take?
@jump target=*menu

*menu
[link target=*left]Take the left road[endlink]
[link target=*right]Take the right road[endlink]

*left
#Guide
The left road is quiet and cool.
@jump target=*end

*right
#Guide
The right road is bright and loud.
@jump target=*end

*end
And so the walk concludes.
