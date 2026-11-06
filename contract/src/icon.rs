//! The token's face: a small SVG drawn from the live state and served by `ft_metadata` as a data
//! URL, so every wallet that shows EMBER shows the fire.
//!
//! The flame's height is the last settled night's pile against its target (before the first
//! night is settled: tonight's pile so far). A lit night stands tall, taller the more it overshot;
//! a smoky night is a low dim flame under grey smoke; an empty night is smoke over cold embers.
//! The current streak is written under the logs.

use crate::Bonfire;
use crate::math::mul_div;
use crate::types::Outcome;

impl Bonfire {
    pub(crate) fn icon(&self) -> String {
        let (pile, target, outcome) = match &self.last {
            Some(l) => (l.pile.0, l.target.0, l.outcome),
            None => (self.pile, self.target, Outcome::Open),
        };
        data_url(&draw(pile, target, outcome, self.streak))
    }
}

/// Flame height in px for a pile at `pct` percent of its target (capped at 150).
fn flame_height(pile: u128, pct: u32) -> u32 {
    if pile == 0 {
        0
    } else if pct >= 100 {
        24 + (pct - 100) * 10 / 50
    } else {
        4 + pct * 16 / 100
    }
}

/// A teardrop with its base centred at (32, 44).
fn flame(h: u32, w: u32, fill: &str) -> String {
    let top = 44 - h;
    let mid = 44 - h * 11 / 20;
    let (l, r) = (32 - w, 32 + w);
    format!("<path d='M32 {top}C{r} {mid} {r} 44 32 44C{l} 44 {l} {mid} 32 {top}Z' fill='{fill}'/>")
}

pub fn draw(pile: u128, target: u128, outcome: Outcome, streak: u32) -> String {
    let pct = if target == 0 { 150 } else { mul_div(pile, 100, target).min(150) as u32 };
    let smoky = matches!(outcome, Outcome::Smoke | Outcome::Empty);
    let h = flame_height(pile, pct);
    let mut s = String::with_capacity(900);
    s.push_str("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>");
    s.push_str("<rect width='64' height='64' rx='14' fill='#1d1426'/>");
    if h > 0 {
        let w = 6 + h / 3;
        let (outer, inner) = if smoky { ("#b4521f", "#e09a3a") } else { ("#ff7a1a", "#ffd23f") };
        s.push_str(&flame(h, w, outer));
        s.push_str(&flame(h * 3 / 5, w * 3 / 5, inner));
    } else {
        s.push_str("<g fill='#e0532a'><circle cx='25' cy='39' r='2'/><circle cx='32' cy='38' r='2'/><circle cx='39' cy='40' r='2'/></g>");
    }
    if smoky {
        let top = if h == 0 { 30 } else { (44 - h as i32 - 8).max(22) };
        s.push_str(&format!(
            "<g fill='#8f8c99' opacity='.8'><circle cx='27' cy='{}' r='6'/><circle cx='37' cy='{}' r='7'/><circle cx='30' cy='{}' r='5'/></g>",
            top,
            top - 6,
            top - 13
        ));
    }
    s.push_str("<path d='M16 50L48 42M16 42L48 50' stroke='#7b4a26' stroke-width='5' stroke-linecap='round'/>");
    s.push_str(&format!(
        "<text x='32' y='61' text-anchor='middle' font-family='sans-serif' font-size='9' font-weight='700' fill='#ffd8a0'>{streak}</text>"
    ));
    s.push_str("</svg>");
    s
}

/// `data:image/svg+xml,` and the SVG, percent-encoded so that only characters RFC 2396 allows
/// unescaped in a URL remain.
pub fn data_url(svg: &str) -> String {
    let mut out = String::with_capacity(svg.len() * 5 / 4 + 32);
    out.push_str("data:image/svg+xml,");
    for b in svg.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()/:;=,".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
