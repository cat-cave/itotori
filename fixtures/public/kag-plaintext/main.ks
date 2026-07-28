; UTSUSHI-008 synthetic KAG .ks probe fixture (CC0, authored — no retail bytes).
; Exercises every trace-kag column on plaintext / already-extracted KAG:
;   labels (*label), a #name speaker, message text, a [macro]...[endmacro]
;   definition + a later invocation, a same-file @jump, and a
;   [link ...]...[endlink] choice menu with two branches to distinct labels.
; Plaintext only: no XP3 container, no encryption, no TJS scripting.
*start|Opening
#Mother
Welcome home. Did you have a good day at school?
[macro name=aside]The house is warm and quiet.[endmacro]
@jump target=*crossroads

*crossroads|Crossroads
#Guide
Which road will you walk?
[link target=*left]Take the left road[endlink]
[link target=*right]Take the right road[endlink]

*left|Left road
#Guide
The left road is calm and shaded.
[aside]
@jump target=*ending

*right|Right road
#Guide
The right road is bright and busy.
@jump target=*ending

*ending|Ending
#Narrator
And so the short walk comes to an end.
