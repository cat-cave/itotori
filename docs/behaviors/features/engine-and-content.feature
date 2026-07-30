Feature: Process owned content without exposing engine internals
  Engine families and profiles are data slots. Qualification, compatibility,
  extraction, and patching keep the same public outcome shape for every row.

  @behavior-support.qualify-profile
  Scenario Outline: Qualify an engine profile without inflating its support
    Given lawful evidence represents <engine_family> with <profile>
    And the requested qualification role is <support_role>
    When the contributor checks identification and every claimed operation through public boundaries
    Then the qualification is <expected_outcome>
    And a real-family claim requires two independent real inputs to satisfy the same public assertions
    And every selected real or derived corpus names its acquisition class, lawful-use basis, family and profile, source identities, hashes, manifest, privacy class, and permitted validation scope
    And an unclassified corpus is inadmissible
    And negative neighbors, collisions, unknown variants, and exact limitations remain visible
    And the receipt names the declared scale and every observed component or exact gap
    And a claimed-scale receipt records exact inputs, outputs, failures, throughput, and cost at the declared whole-work, multi-project, or concurrent scale
    And corresponding synthetic and real observations agree
    And empty, placeholder, stale, missing, or divergent evidence cannot retain qualification
    And every admitted fixture names its provenance, license, privacy class, and permitted evidence role
    And regenerating an admitted fixture deterministically reproduces every declared manifest and content hash
    And an unclassified fixture or copyrighted public fixture cannot qualify

    Examples:
      | engine_family                   | profile                       | support_role        | expected_outcome                    |
      | Fixture/reference               | synthetic conformance profile | synthetic-reference | synthetic qualification only        |
      | RealLive                        | registered production profile | production-target   | qualifies after required evidence   |
      | Siglus                          | registered production profile | production-target   | qualifies after required evidence   |
      | Softpal                         | registered production profile | production-target   | qualifies after required evidence   |
      | NeXAS                           | registered production profile | production-target   | qualifies after required evidence   |
      | RPG Maker MV/MZ                 | registered production profile | production-target   | qualifies after required evidence   |
      | RPG Maker VX Ace/RGSS3          | registered production profile | production-target   | qualifies after required evidence   |
      | KiriKiri/KAG/XP3                | registered production profile | production-target   | qualifies after required evidence   |
      | Ren'Py                          | registered production profile | production-target   | qualifies after required evidence   |
      | Wolf RPG Editor                 | registered production profile | production-target   | qualifies after required evidence   |
      | BGI/Ethornell                   | registered production profile | production-target   | qualifies after required evidence   |
      | Majiro                          | registered production profile | production-target   | qualifies after required evidence   |
      | CatSystem2                      | registered production profile | production-target   | qualifies after required evidence   |
      | TyranoScript                    | registered production profile | production-target   | qualifies after required evidence   |
      | Unity I2 Localization           | bounded production profile    | production-target   | qualifies after required evidence   |
      | Unity/Naninovel                 | bounded production profile    | production-target   | qualifies after required evidence   |
      | MAGES benchmark reference       | benchmark profile             | benchmark-reference | benchmark evidence only              |
      | RPG Maker XP                    | parity profile                | parity-reference    | parity evidence only                 |
      | codeX RScript                   | unqualified target profile    | production-target   | qualifies after required evidence   |
      | Malie                           | unqualified target profile    | production-target   | qualifies after required evidence   |
      | QLIE                            | unqualified target profile    | production-target   | qualifies after required evidence   |
      | Stuff Script Engine             | unqualified target profile    | production-target   | qualifies after required evidence   |
      | Artemis Engine                  | research profile              | research-only       | research evidence only               |
      | CMVS                            | unqualified target profile    | production-target   | qualifies after required evidence   |
      | KID Engine                      | unqualified target profile    | production-target   | qualifies after required evidence   |
      | NScripter                       | excluded profile              | explicit-exclusion  | explicit exclusion                   |
      | Shiina Rio                      | research profile              | research-only       | research evidence only               |
      | System-NNN                      | research profile              | research-only       | research evidence only               |
      | ADV DX                          | unqualified target profile    | production-target   | qualifies after required evidence   |
      | adv32                           | unqualified target profile    | production-target   | qualifies after required evidence   |
      | AliceSoft System3.X             | unqualified target profile    | production-target   | qualifies after required evidence   |
      | AVGEngineV2                     | unqualified target profile    | production-target   | qualifies after required evidence   |
      | CatSystem3                      | unqualified target profile    | production-target   | qualifies after required evidence   |
      | DDSystem                        | unqualified target profile    | production-target   | qualifies after required evidence   |
      | FVP                             | unqualified target profile    | production-target   | qualifies after required evidence   |
      | G2                              | unqualified target profile    | production-target   | qualifies after required evidence   |
      | KaGuYa                          | unqualified target profile    | production-target   | qualifies after required evidence   |
      | LiveMaker                       | research profile              | research-only       | research evidence only               |
      | Lucifen                         | unqualified target profile    | production-target   | qualifies after required evidence   |
      | Musica                          | unqualified target profile    | production-target   | qualifies after required evidence   |
      | Nitroplus System 2              | unqualified target profile    | production-target   | qualifies after required evidence   |
      | PIX STUDIO                      | unqualified target profile    | production-target   | qualifies after required evidence   |
      | Silky Engine                    | unqualified target profile    | production-target   | qualifies after required evidence   |
      | STUDIO SELDOM Adventure System  | unqualified target profile    | production-target   | qualifies after required evidence   |
      | Willadv                         | unqualified target profile    | production-target   | qualifies after required evidence   |
      | Xuse Engine                     | unqualified target profile    | production-target   | qualifies after required evidence   |
      | Yeti/Regista Engine             | unqualified target profile    | production-target   | qualifies after required evidence   |

  @behavior-support.disclose-compatibility
  Scenario Outline: Disclose exact compatibility without inferred downstream support
    Given a user asks about <engine_family> profile <profile>
    When compatibility is requested for the <support_role> row
    Then the report exposes <expected_outcome>
    And it names prerequisites, unsupported legs, limitations, and evidence class
    And every advertised operation has a real nonempty observation at the claimed scale
    And a status string, placeholder, empty selection, or zero-artifact result proves no operation
    And detection, delegation, or a synthetic example never implies an unobserved operation

    Examples:
      | engine_family                   | profile                       | support_role        | expected_outcome                     |
      | Fixture/reference               | synthetic conformance profile | synthetic-reference | synthetic operations only            |
      | RealLive                        | registered production profile | production-target   | declared operations and limitations  |
      | Siglus                          | registered production profile | production-target   | declared operations and limitations  |
      | Softpal                         | registered production profile | production-target   | declared operations and limitations  |
      | NeXAS                           | registered production profile | production-target   | declared operations and limitations  |
      | RPG Maker MV/MZ                 | registered production profile | production-target   | declared operations and limitations  |
      | RPG Maker VX Ace/RGSS3          | registered production profile | production-target   | declared operations and limitations  |
      | KiriKiri/KAG/XP3                | registered production profile | production-target   | declared operations and limitations  |
      | Ren'Py                          | registered production profile | production-target   | declared operations and limitations  |
      | Wolf RPG Editor                 | registered production profile | production-target   | declared operations and limitations  |
      | BGI/Ethornell                   | registered production profile | production-target   | declared operations and limitations  |
      | Majiro                          | registered production profile | production-target   | declared operations and limitations  |
      | CatSystem2                      | registered production profile | production-target   | declared operations and limitations  |
      | TyranoScript                    | registered production profile | production-target   | declared operations and limitations  |
      | Unity I2 Localization           | bounded production profile    | production-target   | declared bounded operations          |
      | Unity/Naninovel                 | bounded production profile    | production-target   | declared bounded operations          |
      | MAGES benchmark reference       | benchmark profile             | benchmark-reference | benchmark-only status                 |
      | RPG Maker XP                    | parity profile                | parity-reference    | parity-reference status               |
      | codeX RScript                   | unqualified target profile    | production-target   | intended operations and missing proof |
      | Malie                           | unqualified target profile    | production-target   | intended operations and missing proof |
      | QLIE                            | unqualified target profile    | production-target   | intended operations and missing proof |
      | Stuff Script Engine             | unqualified target profile    | production-target   | intended operations and missing proof |
      | Artemis Engine                  | research profile              | research-only       | research-only status                  |
      | CMVS                            | unqualified target profile    | production-target   | intended operations and missing proof |
      | KID Engine                      | unqualified target profile    | production-target   | intended operations and missing proof |
      | NScripter                       | excluded profile              | explicit-exclusion  | out-of-scope status                   |
      | Shiina Rio                      | research profile              | research-only       | research-only status                  |
      | System-NNN                      | research profile              | research-only       | research-only status                  |
      | ADV DX                          | unqualified target profile    | production-target   | intended operations and missing proof |
      | adv32                           | unqualified target profile    | production-target   | intended operations and missing proof |
      | AliceSoft System3.X             | unqualified target profile    | production-target   | intended operations and missing proof |
      | AVGEngineV2                     | unqualified target profile    | production-target   | intended operations and missing proof |
      | CatSystem3                      | unqualified target profile    | production-target   | intended operations and missing proof |
      | DDSystem                        | unqualified target profile    | production-target   | intended operations and missing proof |
      | FVP                             | unqualified target profile    | production-target   | intended operations and missing proof |
      | G2                              | unqualified target profile    | production-target   | intended operations and missing proof |
      | KaGuYa                          | unqualified target profile    | production-target   | intended operations and missing proof |
      | LiveMaker                       | research profile              | research-only       | research-only status                  |
      | Lucifen                         | unqualified target profile    | production-target   | intended operations and missing proof |
      | Musica                          | unqualified target profile    | production-target   | intended operations and missing proof |
      | Nitroplus System 2              | unqualified target profile    | production-target   | intended operations and missing proof |
      | PIX STUDIO                      | unqualified target profile    | production-target   | intended operations and missing proof |
      | Silky Engine                    | unqualified target profile    | production-target   | intended operations and missing proof |
      | STUDIO SELDOM Adventure System  | unqualified target profile    | production-target   | intended operations and missing proof |
      | Willadv                         | unqualified target profile    | production-target   | intended operations and missing proof |
      | Xuse Engine                     | unqualified target profile    | production-target   | intended operations and missing proof |
      | Yeti/Regista Engine             | unqualified target profile    | production-target   | intended operations and missing proof |

  @behavior-source.prepare-owned-content
  Scenario Outline: Prepare complete owned content or refuse before downstream work
    Given <engine_family> profile <profile> is supplied as <input_kind>
    And protected access uses <protection_case> through <execution_mode>
    When the producer prepares the selected source
    Then the result is <expected_outcome>
    And success is bound to the complete source revision
    And a prepared source accounts for every declared member and leaves the owned source byte-identical
    And a local inventory contains only engine, profile, count, and hash metadata sufficient for selection
    And malformed metadata, identity mismatch, unsafe paths, unsupported coding, silent skips, incomplete input, or synthetic substitution is refused with a typed diagnostic and no success artifact
    And a wrong helper identity, oversized input, timeout, cancellation, or unapproved helper is refused before execution or secret consumption
    And plain, encrypted, helper-required, misleading, unknown, tampered, oversized, timed-out, cancelled, and unapproved cases retain distinct stable diagnostics
    And public results expose no secret, private path, or reconstructive content

    Examples:
      | engine_family            | profile             | input_kind       | protection_case      | execution_mode      | expected_outcome             |
      | registered native family | protected profile   | owned installation | valid key reference | declared helper     | complete prepared source     |
      | registered plain family  | plain profile       | owned directory  | no key required      | native processing   | complete prepared source     |
      | registered native family | distinct protected profiles | two owned installations | distinct valid key references | declared helpers | complete profile-bound sources |
      | registered family        | unknown profile     | owned installation | missing required key | declared helper    | refusal before downstream work |
      | registered family        | detected profile    | misleading-extension archive | encrypted or protected evidence | native processing | exact evidence classification and diagnostic |
      | registered family        | protected profile   | owned installation | wrong helper identity, oversized input, timeout, cancellation, or unapproved helper | declared helper | refusal before helper execution or secret consumption |
      | registered family        | registered profile  | catalog-addressed owned archive | malformed metadata, identity mismatch, unsafe path, unsupported coding, missing member, or synthetic substitute | native processing | typed refusal with no prepared source |
      | mixed registered families | discovered profiles | mixed local owned corpus | no secret required | redacted inventory | engine, profile, count, and hash metadata without path, filename, or text |

  @behavior-content.extract-complete-scope
  Scenario Outline: Extract configured content into one standard observable format
    Given owned content is identified as <engine_family> profile <profile>
    And its declared role is <support_role>
    When the producer extracts the configured whole-work scope
    Then extraction returns <expected_outcome>
    And successful output preserves stable text, speaker truth, choices, narrative links, assets, protected positions, and source revision
    And every normalized field retains a reversible link to its raw source evidence
    And successful output accounts for every configured source member without a mismatch
    And multiple selected works retain disjoint scopes and shared context
    And field population distinguishes source-absent, extraction-missing, implemented-empty, unsupported, invalid, and unknown values
    And image-text regions retain bounded coordinates, recognized source text, and the source asset hash
    And changing source asset bytes invalidates any prior image-text mapping
    And extraction accepts only registered options for the selected family and refuses omitted or foreign options before work

    Examples:
      | engine_family                   | profile                       | support_role        | expected_outcome                    |
      | Fixture/reference               | synthetic conformance profile | synthetic-reference | synthetic standard bundle only      |
      | RealLive                        | registered production profile | production-target   | standard extracted bundle           |
      | Siglus                          | registered production profile | production-target   | standard extracted bundle           |
      | Softpal                         | registered production profile | production-target   | standard extracted bundle           |
      | NeXAS                           | registered production profile | production-target   | standard extracted bundle           |
      | RPG Maker MV/MZ                 | registered production profile | production-target   | standard extracted bundle           |
      | RPG Maker VX Ace/RGSS3          | registered production profile | production-target   | standard extracted bundle           |
      | KiriKiri/KAG/XP3                | registered production profile | production-target   | standard extracted bundle           |
      | Ren'Py                          | registered production profile | production-target   | standard extracted bundle           |
      | Wolf RPG Editor                 | registered production profile | production-target   | standard extracted bundle           |
      | BGI/Ethornell                   | registered production profile | production-target   | standard extracted bundle           |
      | Majiro                          | registered production profile | production-target   | standard extracted bundle           |
      | CatSystem2                      | registered production profile | production-target   | standard extracted bundle           |
      | TyranoScript                    | registered production profile | production-target   | standard extracted bundle           |
      | Unity I2 Localization           | bounded production profile    | production-target   | bounded standard bundle             |
      | Unity/Naninovel                 | bounded production profile    | production-target   | bounded standard bundle             |
      | MAGES benchmark reference       | benchmark profile             | benchmark-reference | benchmark input only                 |
      | RPG Maker XP                    | parity profile                | parity-reference    | parity reference only                |
      | codeX RScript                   | unqualified target profile    | production-target   | standard bundle after qualification |
      | Malie                           | unqualified target profile    | production-target   | standard bundle after qualification |
      | QLIE                            | unqualified target profile    | production-target   | standard bundle after qualification |
      | Stuff Script Engine             | unqualified target profile    | production-target   | standard bundle after qualification |
      | Artemis Engine                  | research profile              | research-only       | unsupported research result          |
      | CMVS                            | unqualified target profile    | production-target   | standard bundle after qualification |
      | KID Engine                      | unqualified target profile    | production-target   | standard bundle after qualification |
      | NScripter                       | excluded profile              | explicit-exclusion  | out-of-scope result                  |
      | Shiina Rio                      | research profile              | research-only       | unsupported research result          |
      | System-NNN                      | research profile              | research-only       | unsupported research result          |
      | ADV DX                          | unqualified target profile    | production-target   | standard bundle after qualification |
      | adv32                           | unqualified target profile    | production-target   | standard bundle after qualification |
      | AliceSoft System3.X             | unqualified target profile    | production-target   | standard bundle after qualification |
      | AVGEngineV2                     | unqualified target profile    | production-target   | standard bundle after qualification |
      | CatSystem3                      | unqualified target profile    | production-target   | standard bundle after qualification |
      | DDSystem                        | unqualified target profile    | production-target   | standard bundle after qualification |
      | FVP                             | unqualified target profile    | production-target   | standard bundle after qualification |
      | G2                              | unqualified target profile    | production-target   | standard bundle after qualification |
      | KaGuYa                          | unqualified target profile    | production-target   | standard bundle after qualification |
      | LiveMaker                       | research profile              | research-only       | unsupported research result          |
      | Lucifen                         | unqualified target profile    | production-target   | standard bundle after qualification |
      | Musica                          | unqualified target profile    | production-target   | standard bundle after qualification |
      | Nitroplus System 2              | unqualified target profile    | production-target   | standard bundle after qualification |
      | PIX STUDIO                      | unqualified target profile    | production-target   | standard bundle after qualification |
      | Silky Engine                    | unqualified target profile    | production-target   | standard bundle after qualification |
      | STUDIO SELDOM Adventure System  | unqualified target profile    | production-target   | standard bundle after qualification |
      | Willadv                         | unqualified target profile    | production-target   | standard bundle after qualification |
      | Xuse Engine                     | unqualified target profile    | production-target   | standard bundle after qualification |
      | Yeti/Regista Engine             | unqualified target profile    | production-target   | standard bundle after qualification |

  @behavior-patch.produce-safe-output
  Scenario Outline: Produce a verified patch without partial or unsafe writes
    Given accepted targets for <engine_family> profile <profile> have role <support_role>
    And they are bound to the exact source revision and target locale
    When the producer requests a patch
    Then patching returns <expected_outcome>
    And successful output preserves protected order, encoding, structure, untouched bytes, and safe destinations
    And every registered protected construct round-trips byte-for-byte outside accepted translated text
    And an unknown, malformed, deleted, duplicated, corrupt, overlapping, or policy-invalid protected construct fails visibly
    And the produced bytes read back to the exact accepted targets
    And a stale source revision is refused before any target write
    And incomplete scope is refused unless an explicit preview is visibly partial and ineligible for release
    And any preflight failure produces no partial write

    Examples:
      | engine_family                   | profile                       | support_role        | expected_outcome                    |
      | Fixture/reference               | synthetic conformance profile | synthetic-reference | synthetic verified patch only       |
      | RealLive                        | registered production profile | production-target   | verified patch                      |
      | Siglus                          | registered production profile | production-target   | verified patch                      |
      | Softpal                         | registered production profile | production-target   | verified patch                      |
      | NeXAS                           | registered production profile | production-target   | verified patch                      |
      | RPG Maker MV/MZ                 | registered production profile | production-target   | verified patch                      |
      | RPG Maker VX Ace/RGSS3          | registered production profile | production-target   | verified patch                      |
      | KiriKiri/KAG/XP3                | registered production profile | production-target   | verified patch                      |
      | Ren'Py                          | registered production profile | production-target   | verified patch                      |
      | Wolf RPG Editor                 | registered production profile | production-target   | verified patch                      |
      | BGI/Ethornell                   | registered production profile | production-target   | verified patch                      |
      | Majiro                          | registered production profile | production-target   | verified patch                      |
      | CatSystem2                      | registered production profile | production-target   | verified patch                      |
      | TyranoScript                    | registered production profile | production-target   | verified patch                      |
      | Unity I2 Localization           | bounded production profile    | production-target   | bounded verified patch              |
      | Unity/Naninovel                 | bounded production profile    | production-target   | bounded verified patch              |
      | MAGES benchmark reference       | benchmark profile             | benchmark-reference | benchmark input only                 |
      | RPG Maker XP                    | parity profile                | parity-reference    | parity reference only                |
      | codeX RScript                   | unqualified target profile    | production-target   | verified patch after qualification  |
      | Malie                           | unqualified target profile    | production-target   | verified patch after qualification  |
      | QLIE                            | unqualified target profile    | production-target   | verified patch after qualification  |
      | Stuff Script Engine             | unqualified target profile    | production-target   | verified patch after qualification  |
      | Artemis Engine                  | research profile              | research-only       | unsupported research result          |
      | CMVS                            | unqualified target profile    | production-target   | verified patch after qualification  |
      | KID Engine                      | unqualified target profile    | production-target   | verified patch after qualification  |
      | NScripter                       | excluded profile              | explicit-exclusion  | out-of-scope result                  |
      | Shiina Rio                      | research profile              | research-only       | unsupported research result          |
      | System-NNN                      | research profile              | research-only       | unsupported research result          |
      | ADV DX                          | unqualified target profile    | production-target   | verified patch after qualification  |
      | adv32                           | unqualified target profile    | production-target   | verified patch after qualification  |
      | AliceSoft System3.X             | unqualified target profile    | production-target   | verified patch after qualification  |
      | AVGEngineV2                     | unqualified target profile    | production-target   | verified patch after qualification  |
      | CatSystem3                      | unqualified target profile    | production-target   | verified patch after qualification  |
      | DDSystem                        | unqualified target profile    | production-target   | verified patch after qualification  |
      | FVP                             | unqualified target profile    | production-target   | verified patch after qualification  |
      | G2                              | unqualified target profile    | production-target   | verified patch after qualification  |
      | KaGuYa                          | unqualified target profile    | production-target   | verified patch after qualification  |
      | LiveMaker                       | research profile              | research-only       | unsupported research result          |
      | Lucifen                         | unqualified target profile    | production-target   | verified patch after qualification  |
      | Musica                          | unqualified target profile    | production-target   | verified patch after qualification  |
      | Nitroplus System 2              | unqualified target profile    | production-target   | verified patch after qualification  |
      | PIX STUDIO                      | unqualified target profile    | production-target   | verified patch after qualification  |
      | Silky Engine                    | unqualified target profile    | production-target   | verified patch after qualification  |
      | STUDIO SELDOM Adventure System  | unqualified target profile    | production-target   | verified patch after qualification  |
      | Willadv                         | unqualified target profile    | production-target   | verified patch after qualification  |
      | Xuse Engine                     | unqualified target profile    | production-target   | verified patch after qualification  |
      | Yeti/Regista Engine             | unqualified target profile    | production-target   | verified patch after qualification  |
