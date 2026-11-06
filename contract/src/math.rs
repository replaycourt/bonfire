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

/// `x * bp / 10_000`, rounded down.
pub fn bp_of(x: u128, bp: u32) -> u128 {
    mul_div(x, bp as u128, BP)
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
