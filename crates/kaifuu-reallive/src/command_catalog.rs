//! RealLive command opcode catalogue + coverage-manifest classification.
//!
//! Pure `(module_id, opcode) -> bool` tables consumed by the opcode
//! dispatcher's command classifier. Split out from `opcode.rs` to keep that
//! file under its line cap; behaviour is unchanged.

/// True when `(module_id, opcode)` is in the decompiler's semantic
/// operation catalogue. This is deliberately narrower than the old
/// module-family bucket: an unknown opcode inside a known module must
/// become generic `Command` and fail `is_recognized`.
/// Sources:
/// - the generated synthetic coverage manifest's `reallive.opcode_tuple`
///   group, extracted from `utsushi-reallive::module_catalog::REAL_CATALOG`;
/// - the existing first-class per-family opcode tables in
///   `utsushi-reallive::rlop` for operations that no longer live in the
///   gap-fill catalog (`module_jmp`, select-block framing, msg/sys/str/audio
///   basics, and render opcodes).
/// - `docs/research/reallive-semantic-worklist/summary.json` for legacy
///   real-byte tuples that predate the generated manifest's current
///   extraction boundary, notably Kanon's `(module_id=60, opcode=1)`.
pub(crate) fn is_catalogued_command_opcode(module_id: u8, opcode_u16: u16) -> bool {
    match module_id {
        1 => matches!(
            opcode_u16,
            0 | 1
                | 2
                | 3
                | 4
                | 5
                | 6
                | 7
                | 8
                | 9
                | 10
                | 11
                | 12
                | 13
                | 16
                | 17
                | 18
                | 19
                | 20
                | 21
                | 22
                | 30
        ),
        2 => matches!(
            opcode_u16,
            0 | 1 | 2 | 3 | 4 | 14 | 16 | 20 | 22 | 23 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 122
        ),
        3 => matches!(
            opcode_u16,
            1 | 2
                | 3
                | 5
                | 10
                | 14
                | 17
                | 18
                | 19
                | 22
                | 30
                | 31
                | 40
                | 41
                | 100
                | 102
                | 103
                | 104
                | 105
                | 151
                | 152
                | 161
                | 201
                | 205
                | 210
                | 300
                | 301
                | 310
                | 311
                | 400
                | 401
        ),
        4 => matches!(
            opcode_u16,
            0 | 1
                | 2
                | 3
                | 4
                | 5
                | 6
                | 7
                | 8
                | 17
                | 100
                | 101
                | 110
                | 111
                | 112
                | 114
                | 120
                | 121
                | 122
                | 130
                | 131
                | 133
                | 138
                | 140
                | 203
                | 204
                | 205
                | 210
                | 211
                | 212
                | 213
                | 300
                | 301
                | 302
                | 304
                | 305
                | 306
                | 324
                | 332
                | 334
                | 350
                | 351
                | 352
                | 353
                | 354
                | 370
                | 371
                | 372
                | 373
                | 410
                | 451
                | 452
                | 456
                | 457
                | 462
                | 463
                | 464
                | 465
                | 466
                | 467
                | 468
                | 469
                | 500
                | 510
                | 511
                | 600
                | 610
                | 620
                | 630
                | 780
                | 800
                | 1000
                | 1002
                | 1007
                | 1008
                | 1100
                | 1101
                | 1102
                | 1200
                | 1201
                | 1203
                | 1205
                | 1211
                | 1212
                | 1213
                | 1214
                | 1215
                | 1216
                | 1219
                | 1221
                | 1222
                | 1231
                | 1300
                | 1301
                | 1409
                | 1413
                | 1421
                | 1424
                | 1459
                | 1502
                | 1504
                | 1520
                | 1700
                | 1701
                | 1703
                | 1710
                | 1711
                | 2001
                | 2003
                | 2010
                | 2011
                | 2051
                | 2053
                | 2061
                | 2223
                | 2224
                | 2225
                | 2230
                | 2231
                | 2232
                | 2233
                | 2240
                | 2241
                | 2242
                | 2243
                | 2250
                | 2260
                | 2261
                | 2262
                | 2263
                | 2264
                | 2275
                | 2323
                | 2324
                | 2325
                | 2330
                | 2331
                | 2332
                | 2333
                | 2340
                | 2341
                | 2342
                | 2343
                | 2350
                | 2360
                | 2361
                | 2362
                | 2363
                | 2364
                | 2375
                | 2600
                | 2601
                | 2610
                | 2611
                | 2612
                | 2613
                | 2614
                | 2630
                | 2631
                | 2632
                | 2633
                | 2634
                | 2635
                | 2636
                | 2637
                | 3001
                | 3106
                | 3108
                | 3126
                | 3128
                | 3501
                | 3502
                | 3503
        ),
        5 => matches!(opcode_u16, 0 | 120),
        10 => matches!(
            opcode_u16,
            0 | 1 | 2 | 3 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 41 | 100
        ),
        11 => matches!(opcode_u16, 0..=7),
        20 => matches!(opcode_u16, 0 | 1 | 2 | 3 | 4 | 5 | 105 | 106),
        21 => matches!(opcode_u16, 0 | 1 | 2 | 5 | 105),
        22 => matches!(opcode_u16, 0..=2),
        23 => matches!(opcode_u16, 0 | 1 | 3 | 4 | 5 | 6 | 8 | 15 | 101),
        30 => matches!(opcode_u16, 0 | 2 | 20 | 22 | 31),
        31 => matches!(opcode_u16, 0),
        33 => matches!(
            opcode_u16,
            15 | 16
                | 31
                | 32
                | 50
                | 51
                | 70
                | 71
                | 72
                | 73
                | 74
                | 75
                | 76
                | 77
                | 100
                | 101
                | 201
                | 300
                | 301
                | 302
                | 303
                | 403
                | 406
                | 1053
                | 1055
                | 1056
                | 1057
                | 1100
                | 1101
                | 1201
        ),
        40 => matches!(opcode_u16, 10),
        60 => matches!(opcode_u16, 0 | 1 | 2 | 10 | 11 | 100),
        61 => matches!(opcode_u16, 0 | 6 | 10 | 11 | 100 | 111),
        62 => matches!(opcode_u16, 0 | 10 | 11 | 100 | 111),
        71 => matches!(
            opcode_u16,
            1000 | 1001 | 1003 | 1005 | 1101 | 1200 | 1300 | 1400 | 1500
        ),
        72 => matches!(
            opcode_u16,
            1000 | 1001 | 1003 | 1005 | 1100 | 1101 | 1200 | 1300 | 1400 | 1500
        ),
        73 => matches!(opcode_u16, 1006 | 3003),
        81 => matches!(
            opcode_u16,
            1000 | 1001
                | 1002
                | 1003
                | 1004
                | 1006
                | 1007
                | 1009
                | 1010
                | 1011
                | 1012
                | 1016
                | 1024
                | 1025
                | 1026
                | 1031
                | 1034
                | 1037
                | 1038
                | 1039
                | 1046
                | 1047
                | 1048
                | 1060
                | 1064
                | 1066
                | 1067
                | 2004
                | 3004
                | 4004
        ),
        82 => matches!(
            opcode_u16,
            1000 | 1001
                | 1002
                | 1003
                | 1004
                | 1006
                | 1009
                | 1010
                | 1011
                | 1012
                | 1016
                | 1026
                | 1031
                | 1034
                | 1039
                | 1046
                | 1047
                | 1048
                | 1064
        ),
        84 => matches!(opcode_u16, 1000 | 1004 | 1007 | 1100),
        85 => matches!(opcode_u16, 1000),
        90 => matches!(
            opcode_u16,
            1000 | 1001
                | 1002
                | 1003
                | 1004
                | 1006
                | 1009
                | 1010
                | 1011
                | 1012
                | 1016
                | 1026
                | 1039
                | 1046
                | 1047
                | 1048
                | 1066
                | 2004
        ),
        91 => matches!(
            opcode_u16,
            1000 | 1001
                | 1002
                | 1003
                | 1004
                | 1006
                | 1009
                | 1010
                | 1011
                | 1012
                | 1016
                | 1026
                | 1039
                | 1046
                | 1047
                | 1048
                | 1064
                | 2004
        ),
        _ => false,
    }
}

mod coverage_manifest;
pub(crate) use coverage_manifest::is_coverage_manifest_opcode;
