; Synthetic KAG .ks fixture (CC0, authored) — macro DEFINITION + invocation
; with %param substitution (the supported bounded macro subset). Defining a
; macro emits nothing; invoking an earlier-defined macro EXPANDS its body with
; %param substituted, so the trace shows the EXPANDED body (a #name line and a
; message run) — not the raw [greet ...] invocation, and not a diagnostic.
[macro name="greet"]
#%who
Hello, I am %who.
[endmacro]
*start
[greet who="Alice"]
[greet who="Bob"]
