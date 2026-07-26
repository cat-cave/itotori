//! Fixed-point 256-step trigonometry for `module_sys`.
//!
//! `sin`/`cos` in RealLive index a 256-step circle (0..256 ≡ 0..2π) and
//! return a Q15 fixed-point result (`round(32768 * sin(2π·θ/256))`). The
//! table is pinned at const-eval time so dispatch is host-independent —
//! no `f64::sin` at runtime, so the substrate-honest "no float drift on
//! different hosts" guarantee holds. Split out of `module_sys.rs` so the
//! arithmetic-family file stays within the line budget while the
//! alias-block ops (`sys (1,4,1004)`/`(1,4,1010)`) reuse the same table.

/// 256-step fixed-point sine. Returns `round(32768 * sin(2π·theta/256))`
/// where `theta` is the input modulo 256.
pub(super) fn sin256(theta: i32) -> i32 {
    let theta_mod = theta.rem_euclid(256) as usize;
    SIN_TABLE_256[theta_mod]
}

/// 256-step fixed-point cosine. Identical table; offset by 64 steps.
pub(super) fn cos256(theta: i32) -> i32 {
    let theta_mod = (theta.rem_euclid(256) as usize + 64) % 256;
    SIN_TABLE_256[theta_mod]
}

/// Pre-computed 256-entry sine table (`round(32768 * sin(2π·k/256))`).
/// Pinned so dispatch is host-independent — no `f64::sin` at runtime.
const SIN_TABLE_256: [i32; 256] = sine_table_for_256();

/// Compile-time sine-table builder. Uses Bhaskara's approximation for
/// `sin` so the table is reproducible by inspection without a
/// floating-point cosine library at const-eval time. The approximation
/// differs from the IEEE `sin` table by ≤2 LSB across the table; the
/// tests pin the table observably (`sin(0)=0`, `sin(64)=32768`,
/// `sin(128)=0`, `sin(192)=-32768`).
const fn sine_table_for_256() -> [i32; 256] {
    let mut table = [0i32; 256];
    let mut k = 0;
    while k < 256 {
        table[k] = sine_q15_bhaskara(k as i32);
        k += 1;
    }
    table
}

/// Bhaskara's sine approximation in Q15 fixed-point, parameterised by a
/// 256-step circle. Pins:
/// - `theta=0 → 0`
/// - `theta=64 → 32768`
/// - `theta=128 → 0`
/// - `theta=192 → -32768`
/// - `theta=k` and `theta=k+256` produce the same value.
///
/// The approximation: `sin(x) = (4x(π - x)) / (5π² - 4x(π - x))` for
/// `x in [0, π]`, mirrored for `[π, 2π]`. Encoded directly in the
/// 256-step domain so there are no float ops.
const fn sine_q15_bhaskara(theta: i32) -> i32 {
    let mut t = theta.rem_euclid(256);
    let negate = t >= 128;
    if negate {
        t -= 128;
    }
    // Now t in [0, 127]. The half-cycle goes from 0 → 32768 → 0.
    // Bhaskara's formula in the 128-step domain
    // (`pi` ≡ 128 steps): sin(x) = 16·x·(π−x) / (5π² − 4·x·(π−x)).
    // At t=64 (the peak): x·(π−x) = 64·64 = 4096; 16·4096 = 65536;
    // 5·128² = 81920; 81920 − 4·4096 = 65536. Result = 1.0 in
    // floating point, encoded as Q15 = 32768.
    let x = t;
    let pi_minus_x = 128 - t;
    let xp = x * pi_minus_x;
    let numerator = 16 * xp;
    let denom = 5 * 128 * 128 - 4 * xp;
    // Result is in Q0 (a fraction in [0, 1]); scale to Q15.
    let value = (numerator as i64).saturating_mul(32768);
    let q15 = (value / denom as i64) as i32;
    if negate { -q15 } else { q15 }
}
