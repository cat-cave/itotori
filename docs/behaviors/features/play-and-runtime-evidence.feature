Feature: Play patched content and retain honest runtime evidence
  A runtime is observed through causal input, visible or audible output, durable
  replay, and privacy-safe artifacts rather than implementation state.

  @behavior-play.launch-patched-content
  Scenario Outline: Launch the exact patch with truthful availability
    Given patch <patch_revision> targets <engine_family> profile <profile>
    And the family row is <support_role>
    When the reviewer starts a declared playback scenario
    Then launch returns <expected_outcome>
    And a successful session consumes the exact patch with no fallback to source
    And changing only patch bytes changes the linked visible text or frame
    And a missing patched artifact fails validation instead of launching source content
    And successful and unavailable cases have the same core result across two declared transports
    And running, completed, cancelled, unavailable, and failed sessions expose distinct schema-valid status, progress, limitations, evidence links, last failure, and visible treatment
    And any delegated runtime is named, satisfies the same product contract, and never counts launching as extraction evidence
    And public launch results expose no launch command or local path
    And unavailable, cancelled, and failed outcomes remain distinct

    Examples:
      | engine_family                   | profile                       | support_role        | patch_revision | expected_outcome                      |
      | Fixture/reference               | synthetic conformance profile | synthetic-reference | patch-one     | synthetic session only                |
      | RealLive                        | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | Siglus                          | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | Softpal                         | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | NeXAS                           | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | RPG Maker MV/MZ                 | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | RPG Maker VX Ace/RGSS3          | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | KiriKiri/KAG/XP3                | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | Ren'Py                          | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | Wolf RPG Editor                 | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | BGI/Ethornell                   | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | Majiro                          | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | CatSystem2                      | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | TyranoScript                    | registered production profile | production-target   | patch-one      | patched session after qualification   |
      | Unity I2 Localization           | bounded production profile    | production-target   | patch-one      | bounded session after qualification   |
      | Unity/Naninovel                 | bounded production profile    | production-target   | patch-one      | bounded session after qualification   |
      | MAGES benchmark reference       | benchmark profile             | benchmark-reference | patch-one      | benchmark input only                  |
      | RPG Maker XP                    | parity profile                | parity-reference    | patch-one      | parity reference only                 |
      | codeX RScript                   | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | Malie                           | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | QLIE                            | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | Stuff Script Engine             | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | Artemis Engine                  | research profile              | research-only       | patch-one      | unsupported research result           |
      | CMVS                            | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | KID Engine                      | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | NScripter                       | excluded profile              | explicit-exclusion  | patch-one      | out-of-scope result                   |
      | Shiina Rio                      | research profile              | research-only       | patch-one      | unsupported research result           |
      | System-NNN                      | research profile              | research-only       | patch-one      | unsupported research result           |
      | ADV DX                          | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | adv32                           | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | AliceSoft System3.X             | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | AVGEngineV2                     | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | CatSystem3                      | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | DDSystem                        | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | FVP                             | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | G2                              | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | KaGuYa                          | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | LiveMaker                       | research profile              | research-only       | patch-one      | unsupported research result           |
      | Lucifen                         | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | Musica                          | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | Nitroplus System 2              | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | PIX STUDIO                      | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | Silky Engine                    | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | STUDIO SELDOM Adventure System  | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | Willadv                         | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | Xuse Engine                     | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |
      | Yeti/Regista Engine             | unqualified target profile    | production-target   | patch-one      | patched session after qualification   |

  @behavior-play.control-reproducible-session
  Scenario Outline: Control and restore a reproducible causal session
    Given <engine_family> profile <profile> is at checkpoint <checkpoint_cut>
    And the input log contains <input_case> under <clock_case>
    And execution comparison is <execution_case>
    When the reviewer replays, restores, and seeks <seek_case> at <placement>
    Then each input is consumed exactly once and causes <control_outcome>
    And a clean replay has <replay_outcome>
    And synchronized observable sinks end as <sink_outcome>
    And a compatible snapshot restores identical state, frame, and trace hashes after restart
    And an oversized, stale-version, wrong-profile, or corrupt snapshot is refused explicitly without changing state
    And an undeclared operation returns a typed unsupported-operation result without changing the checkpoint
    And live and recorded sessions with the same events produce the same visible player state
    And malformed or stale events are rejected before rendering
    And declared rendering-only differences remain isolated from semantic events
    And mismatched source, patch, profile, locale, clock, or seed is refused

    Examples:
      | engine_family            | profile             | checkpoint_cut | input_case                              | clock_case   | execution_case                         | seek_case                      | placement   | control_outcome                       | replay_outcome                  | sink_outcome                                        |
      | registered native family | registered profile  | before advance | one advance input                       | fixed ticks  | one native execution                   | the restored checkpoint        | self-hosted | one causal advance                    | identical checkpoints           | text, frame, audio, and state stay synchronized      |
      | registered web family    | registered profile  | before choice  | choice index one                        | virtual time | one web execution                      | the restored checkpoint        | managed     | the selected branch only              | identical restored branch       | choice, frame, and state stay synchronized           |
      | registered family        | registered profile  | before choice  | the same recorded product coordinates at three viewport scales | virtual time | three viewport transforms | the selected branch checkpoint | managed | the same intended target and causal branch at all three scales | identical branch identity | pointer, choice, frame, and state stay synchronized |
      | registered family        | registered profile  | before replay  | one recorded causal input sequence      | fixed ticks  | two independent sessions               | three recorded points          | self-hosted | each selected point exactly once      | identical checkpoint hashes     | text, choices, frames, audio, and state all align    |
      | registered family        | registered profile  | before replay  | one portable input sequence             | virtual time | native and web execution targets       | the same recorded point        | managed     | equivalent semantic events            | equivalent semantic traces      | only declared rendering differences remain          |
      | registered family        | registered profile  | before restore | an oversized, stale-version, wrong-profile, or corrupt snapshot | fixed ticks | one restarted execution | the rejected checkpoint | self-hosted | no state change | explicit class-specific refusal | no new text, frame, audio, choice, or state event |
      | registered family        | registered profile  | before operation | one undeclared operation             | fixed ticks  | one controlled session                | the unchanged checkpoint       | self-hosted | typed unsupported-operation refusal  | identical checkpoint hash       | no text, frame, audio, choice, or state change       |
      | Softpal                  | registered profile  | before choice  | immediate and decoupled choice inputs   | fixed ticks  | two profiled choice variants           | each expected branch           | self-hosted | the exact branch without index drift  | identical branch checkpoints    | choice, frame, and state stay synchronized           |
      | KiriKiri/KAG/XP3         | registered profile  | before replay  | one page-aware input sequence           | virtual time | equivalent packed and loose executions | every page boundary            | self-hosted | each page transition exactly once     | equivalent semantic traces      | ordered message boxes and state stay synchronized    |

  @behavior-play.explore-routes
  Scenario Outline: Explore routes with truthful bounded coverage
    Given <engine_family> profile <profile> starts from <start_mode>
    When <exploration_policy> explores <scope>
    Then choices, selected indices, routes, moments, and terminals are linked
    And loops remain bounded by <bound_case>
    And coverage ends as <coverage_outcome> without claiming unseen content

    Examples:
      | engine_family            | profile            | start_mode       | exploration_policy | scope          | bound_case         | coverage_outcome          |
      | registered native family | registered profile | a new session    | enumerate choices  | bounded route  | declared visit cap | complete for that route   |
      | registered web family    | registered profile | a saved checkpoint | resume and branch | configured work | declared time cap | explicitly incomplete     |

  @behavior-play.observe-localized-surfaces
  Scenario Outline: Observe meaningful localized audiovisual surfaces
    Given <engine_family> profile <profile> runs the selected patch at <placement>
    And the presentation uses <presentation_case>
    When the reviewer reaches <surface> in <viewport_case>
    Then the observed output is <surface_outcome>
    And target text, choices, layout, graphics, audio, input, and system effects remain ordered
    And changing only selected patch bytes changes the linked visible or audible surface
    And comparison against <reference_case> ends as <comparison_outcome>
    And any approximation or unknown required operation is disclosed instead of silently accepted

    Examples:
      | engine_family            | profile             | placement    | presentation_case                      | surface          | viewport_case     | surface_outcome                              | reference_case                                      | comparison_outcome                  |
      | registered native family | registered profile  | self-hosted  | expected dialogue presentation         | dialogue box     | locked width      | legible localized text and audible voice     | the expected text-window state                      | matches the reference               |
      | registered web family    | registered profile  | managed      | expected choice presentation           | choice screen    | locked width      | interactive localized choices                | the expected interactive choice state               | matches the reference               |
      | registered family        | registered profile  | self-hosted  | missing required audio                 | required audio   | supported route   | a loud failure when audio is unavailable     | the required audible event sequence                 | rejected as incomplete              |
      | registered native family | registered profile  | self-hosted  | expected visible layer order and blend | composed scene   | overlap case      | the expected composed pixels and visible order | an overlap reference with declared visible blending | matches the reference              |
      | registered native family | registered profile  | self-hosted  | swapped visible layers or blend modes  | composed scene   | overlap case      | a visible composition mismatch               | the same overlap reference                          | rejected                            |
      | registered native family | registered profile  | self-hosted  | multiple window and markup cases       | dialogue window  | scripted inputs   | the expected visible window state and pixels | the corresponding visible-state captures            | every case matches                  |
      | registered native family | registered profile  | self-hosted  | expected composed checkpoint           | rendered frame   | declared threshold | localized text in a meaningful composed frame | the corresponding reference capture                | meets the declared image threshold  |
      | registered native family | registered profile  | self-hosted  | blank or uniformly colored output      | rendered frame   | correct frame count | no meaningful composed content               | the corresponding reference capture                | rejected despite the correct count  |
      | registered family        | registered profile  | self-hosted  | selected image and audio replacements  | patched assets   | selected scope     | the replacement image is visible and replacement audio is heard | the source build and selected patch | only selected assets differ       |
      | registered family        | registered profile  | self-hosted  | the localized patch is reverted        | dialogue frame   | exact player moment | source text returns and target text is absent | the prior source and target observations             | matches the source reference         |
      | registered family        | registered profile  | self-hosted  | seeded overflow, missing glyph, wrong branch label, and missing image text | patched review surfaces | required moments | every seeded presentation defect is visible | the corresponding accepted presentation references | each defect is rejected             |
      | Softpal                  | registered profile  | self-hosted  | both registered choice variants        | dialogue and choices | expected branches | changed target text with intact choice targets | the corresponding source and target checkpoints    | every branch and frame matches       |
      | RPG Maker MV/MZ          | registered profile  | managed      | configured core and extension text     | maps, events, choices, and interface text | automated route | every configured target unit is visible | the configured target-unit inventory                 | omitted observation is rejected      |
      | RPG Maker VX Ace/RGSS3   | registered profile  | self-hosted  | declared native-compatible transport   | translated dialogue | configured route | bound translated text or an explicit unavailable result | the selected patch and declared dependency posture | never promoted from unavailable      |
      | KiriKiri/KAG/XP3         | registered profile  | self-hosted  | equivalent packed and loose input      | protected dialogue pages | recorded route | equivalent ordered visible pages       | the same source and target moments                  | equivalent semantic output           |
      | Ren'Py                   | registered profile  | managed      | native and web transports              | labels, menus, screen text, and callbacks | configured routes | matching semantic output with exact platform differences | the registered transport observations              | every difference is declared         |
      | Wolf RPG Editor          | registered profile  | self-hosted  | two declared protection variants       | patched database and common-event text | linked moments | changed target text with stable structure links | the corresponding source and target observations   | every link resolves                  |
      | BGI/Ethornell            | registered profile  | self-hosted  | growing and shrinking target strings   | referenced dialogue and choices | expected moments | changed text at each expected moment    | the patched native-reference inventory              | every moment links exactly once      |
      | Unity I2 Localization    | bounded profile     | managed      | registered table-key lookups           | bounded localized table text | configured route | captured target text for admitted keys  | the bounded table-key profile                       | a non-profile lookup is rejected     |
      | Unity/Naninovel          | bounded profile     | managed      | independently qualified observations   | profile-specific dialogue and choices | configured route | observations from the selected profile only | the selected profile rather than another Unity profile | foreign evidence is rejected      |

  @behavior-evidence.capture-runtime-observation
  Scenario Outline: Capture complete observations bound to the exact patch
    Given <producer_class> for <engine_family> profile <profile> runs patch <patch_revision> from <source_revision> at <placement>
    And the capture plan requires <observation_kind> under <capture_case> as <evidence_role>
    When the planned input log completes
    Then captured frames, events, checkpoints, and counts are bound to that exact run
    And completeness is <capture_outcome>
    And evidence-role validation ends as <role_outcome>
    And source, target, and runtime linkage ends as <linkage_outcome>
    And a successful capture yields a navigable artifact reference
    And a missing required observation cannot produce a passing capture

    Examples:
      | producer_class                | engine_family            | profile             | patch_revision | source_revision | placement   | observation_kind                   | capture_case                                      | evidence_role          | capture_outcome       | role_outcome                         | linkage_outcome                                      |
      | reimplementation producer     | registered native family | registered profile  | patch-one      | source-one      | self-hosted | frame and audio                     | all required moments                              | runtime observation    | complete              | accepted as reimplementation evidence | every event links to its source and target moment    |
      | managed browser producer      | registered web family    | registered profile  | patch-two      | source-two      | managed     | live rendered text                  | one moment missing                                | runtime observation    | failed as incomplete  | rejected as incomplete                 | the exact missing moment is named                    |
      | native reference producer     | registered family        | registered profile  | source-build   | source-three    | self-hosted | reference frames and events         | producer and revision provenance present           | reference capture      | complete              | accepted as reference evidence          | reference moments resolve to the source revision     |
      | reimplementation replay       | registered family        | registered profile  | patch-three    | source-three    | self-hosted | one replay frame substituted        | replay output presented as a reference             | reference capture      | complete bytes        | rejected for the wrong producer class   | no comparison accepts the substituted frame          |
      | reimplementation producer     | registered family        | registered profile  | patch-four     | source-four     | self-hosted | aligned source and target frames    | selected and reverted patch observations           | runtime observation    | complete              | accepted as reimplementation evidence   | matching unit and frame links lose target on reversion |
      | reimplementation producer     | registered family        | registered profile  | patch-five     | source-five     | self-hosted | frame and moment findings           | overflow, missing glyph, wrong branch, and image text defects | runtime observation | complete           | accepted as defect evidence             | every finding links to the exact frame and moment     |
      | reimplementation producer     | registered family        | registered profile  | patch-six      | source-six      | managed     | frame dimensions and viewport transforms | the same recorded product coordinates at three viewport scales | runtime observation | complete | accepted as causal input evidence | captured dimensions and transforms agree and select the same intended target at all three scales |

  @behavior-evidence.publish-safe-runtime-proof
  Scenario Outline: Publish safe runtime proof without weakening private evidence
    Given runtime evidence for <engine_family> profile <profile> has <visibility>
    And it contains <artifact_kind> under <retention_class>
    When an authorized actor resolves or publishes the evidence
    Then the result is <publication_outcome>
    And public output omits reconstructive content, secrets, private paths, and private identities
    And a stale, missing, or hash-mismatched artifact invalidates the proof

    Examples:
      | engine_family            | profile            | visibility  | artifact_kind       | retention_class | publication_outcome                    |
      | registered native family | registered profile | private     | full runtime capture | project policy | authorized full evidence resolves      |
      | registered web family    | registered profile | public-safe | redacted summary     | public policy  | non-reconstructive derivative resolves |
