//! Integer arithmetic. Every division rounds down; the callers decide where the remainder goes.

use crate::config::BP;
use near_sdk::env;

const LOW: u128 = u64::MAX as u128;

/// `a * b / c`, rounded down, with a 256-bit intermediate product. The quotient must fit in a u128,
/// which holds wherever the contract uses it (`b <= c`, or `c` is `BP` and `b <= BP`).
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    if c == 0 {
        env::panic_str("division by zero");
    }
    if let Some(p) = a.checked_mul(b) {
        return p / c;
    }
    let (hi, lo) = mul_wide(a, b);
    if hi >= c {
        env::panic_str("quotient overflow");
    }
    // Restoring division of the 256-bit product, one bit of the low half at a time. `rem < c`
    // holds before every step; `carry` keeps the bit a shift pushes out of a u128.
    let mut rem = hi;
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= c {
            rem = rem.wrapping_sub(c);
            q |= 1;
        }
    }
    q
}

/// The full 256-bit product as (high, low).
pub fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a1, a0) = (a >> 64, a & LOW);
    let (b1, b0) = (b >> 64, b & LOW);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & LOW) + (p10 & LOW);
    let lo = (p00 & LOW) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// `a * b / c`, rounded up. Same bounds as `mul_div`.
pub fn mul_div_ceil(a: u128, b: u128, c: u128) -> u128 {
    let q = mul_div(a, b, c);
    let (ph, pl) = mul_wide(a, b);
    let (qh, ql) = mul_wide(q, c);
    if (qh, ql) < (ph, pl) { q + 1 } else { q }
}

/// `x * bp / 10_000`, rounded down.
pub fn bp_of(x: u128, bp: u32) -> u128 {
    mul_div(x, bp as u128, BP)
}

/// Weight of `below` units of wood landing on a pile that already holds `before`, for a night
/// with `target` (`before + below <= target`): the integral of the pile-position factor, which
/// falls linearly from `early_max_bp` on an empty pile to 10000 at the target, rounded down.
///
/// The reference model writes it `below * (em * 2T - (em - 10000) * (2 * before + below)) / 2T`.
/// Since `below * em * 2T / 2T` is whole, that is `below * em - ceil(below * (em - 10000) *
/// (2 * before + below) / 2T)`, which keeps every intermediate inside a u128 at the supply cap.
pub fn slice_weight(target: u128, early_max_bp: u32, before: u128, below: u128) -> u128 {
    if below == 0 {
        return 0;
    }
    let span = (early_max_bp as u128) - BP;
    below * early_max_bp as u128 - mul_div_ceil(below * span, 2 * before + below, 2 * target)
}

/// Pooled windows: the weight of each window's wood, in window order. A window's wood covers the
/// slice of the pile from the wood of all earlier windows upward; the part below the target weighs
/// its slice, the part above it `late_lit_bp` per unit.
pub fn window_weights(windows: &[u128], target: u128, early_max_bp: u32, late_lit_bp: u32) -> Vec<(u128, u128)> {
    let mut start: u128 = 0;
    windows
        .iter()
        .map(|&x| {
            let below = if start >= target { 0 } else { x.min(target - start) };
            let w = slice_weight(target, early_max_bp, start, below) + (x - below) * late_lit_bp as u128;
            start += x;
            (x, w)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn le(a: (u128, u128), b: (u128, u128)) -> bool {
        a.0 < b.0 || (a.0 == b.0 && a.1 <= b.1)
    }

    fn add(a: (u128, u128), b: (u128, u128)) -> (u128, u128) {
        let (lo, c) = a.1.overflowing_add(b.1);
        (a.0 + b.0 + c as u128, lo)
    }

    /// q = floor(a*b/c) exactly when q*c <= a*b < q*c + c.
    fn check(a: u128, b: u128, c: u128) {
        let q = mul_div(a, b, c);
        let qc = mul_wide(q, c);
        let ab = mul_wide(a, b);
        assert!(le(qc, ab), "{a} * {b} / {c} = {q} is too big");
        assert!(!le(add(qc, (0, c)), ab), "{a} * {b} / {c} = {q} is too small");
    }

    #[test]
    fn ceiling_division_rounds_up_only_with_a_remainder() {
        assert_eq!(mul_div_ceil(7, 3, 2), 11);
        assert_eq!(mul_div_ceil(8, 3, 2), 12);
        assert_eq!(mul_div_ceil(u128::MAX, u128::MAX - 1, u128::MAX), u128::MAX - 1);
        assert_eq!(mul_div_ceil(u128::MAX, 3, 4), u128::MAX / 4 * 3 + 3);
    }

    /// The reference model's formula with a 256-bit numerator, for comparison.
    fn slice_reference(t: u128, em: u128, before: u128, below: u128) -> u128 {
        // below * (em * 2t - (em - BP) * (2 before + below)) / 2t, all terms non-negative.
        let inner_hi = mul_wide(em, 2 * t);
        let inner_lo = mul_wide(em - BP, 2 * before + below);
        let (lo, borrow) = inner_hi.1.overflowing_sub(inner_lo.1);
        let inner = (inner_hi.0 - inner_lo.0 - borrow as u128, lo);
        assert_eq!(inner.0, 0, "the factor integral fits a u128 here");
        mul_div(below, inner.1, 2 * t)
    }

    #[test]
    fn the_slice_weight_matches_the_reference_formula() {
        let t = 20_000u128 * 10u128.pow(18);
        for (before, below) in [(0, t), (0, 1), (t - 1, 1), (t / 3, t / 3), (12_345, 6_789), (t / 2, t / 2)] {
            assert_eq!(slice_weight(t, 40_000, before, below), slice_reference(t, 40_000, before, below));
        }
        // A whole pile in one go earns the average factor (early_max + 1) / 2.
        assert_eq!(slice_weight(1_000, 40_000, 0, 1_000), 1_000 * 25_000);
        // The first unit earns early_max (rounded down), the last almost 1.0.
        assert_eq!(slice_weight(1_000, 40_000, 0, 1), 39_985);
        assert_eq!(slice_weight(1_000, 40_000, 999, 1), 10_015);
        // Splitting the slice never changes it by more than the rounding of each part.
        let whole = slice_weight(t, 40_000, 0, t);
        let parts: u128 = (0..10).map(|i| slice_weight(t, 40_000, i * t / 10, t / 10)).sum();
        assert!(whole - parts < 10);
    }

    #[test]
    fn the_slice_weight_fits_at_the_supply_cap() {
        let cap = 1u128 << 112;
        let w = slice_weight(cap, 60_000, 0, cap);
        assert_eq!(w, cap * 35_000);
        assert_eq!(slice_weight(cap, 60_000, cap / 2, cap / 2), slice_weight(cap, 60_000, cap / 2, cap / 2));
        let windows = window_weights(&[cap / 2, cap / 2, cap / 4], cap, 60_000, 10_000);
        assert_eq!(windows[2].1, cap / 4 * 10_000);
    }

    #[test]
    fn small_products_divide_directly() {
        assert_eq!(mul_div(7, 3, 2), 10);
        assert_eq!(mul_div(0, 3, 2), 0);
        assert_eq!(bp_of(12_345, 500), 617);
    }

    #[test]
    fn wide_products_divide_exactly() {
        let big = u128::MAX;
        assert_eq!(mul_div(big, big, big), big);
        assert_eq!(mul_div(1 << 127, 4, 8), 1 << 126);
        assert_eq!(mul_div(big, 3, 4), big / 4 * 3 + 2);
        check(big, big - 1, big);
        check(big - 7, 1 << 100, (1 << 101) + 3);
        check((1 << 112) + 12_345, (1 << 112) * 3 + 1, (1 << 112) * 5 + 77);
    }

    #[test]
    fn random_products_match_the_definition() {
        let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        for _ in 0..20_000 {
            let r = |x: u64, y: u64, bits: u64| ((x as u128) << 64 | y as u128) >> (bits % 128);
            let a = r(next(), next(), next());
            let c = r(next(), next(), next()).max(1);
            // Keep the quotient inside a u128: b <= c.
            let b = r(next(), next(), next()) % c + 1;
            let b = b.min(c);
            check(a, b, c);
        }
    }
}
