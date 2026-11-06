//! The token's face: a small SVG drawn from the live state and served by `ft_metadata` as a data
//! URL, so every wallet that shows EMBER shows the fire, and the fire is the chart.
//!
//! - At the top, the last night's word: `LIT ×N` (N is the streak, and the text grows with it),
//!   `SMOKED` or `COLD`.
//! - In the middle, the last night's fire: a lit night stands tall, taller the more it overshot;
//!   a smoky night is a low dim flame under grey smoke; a cold night is smoke over cold embers.
//!   Before the first night is settled it shows tonight's pile so far.
//! - Along the bottom, the last seven nights, oldest first: a small flame for a lit night, a grey
//!   puff for a smoky one, a hollow ring for a cold one.

use crate::Bonfire;
use crate::config::ICON_NIGHTS;
use crate::math::mul_div;
use crate::types::Outcome;

impl Bonfire {
    pub(crate) fn icon(&self) -> String {
        let (pile, target, outcome) = match &self.last {
            Some(l) => (l.pile.0, l.target.0, l.outcome),
            None => (self.pile, self.target, Outcome::Open),
        };
        let nights = self.recent_outcomes(ICON_NIGHTS);
        data_url(&draw(pile, target, outcome, self.streak, &nights))
    }
}

/// The word at the top and its font size.
pub fn label(outcome: Outcome, streak: u32) -> (String, u32, &'static str) {
    match outcome {
        Outcome::Lit => (format!("LIT \u{00d7}{streak}"), 8 + streak.min(15) / 3, "#ffd23f"),
        Outcome::Smoked => ("SMOKED".into(), 8, "#c9c5d6"),
        Outcome::Cold => ("COLD".into(), 8, "#9fbfe0"),
        Outcome::Open => ("FIRST NIGHT".into(), 7, "#ffd8a0"),
    }
}

/// Flame height in px for a pile at `pct` percent of its target (capped at 150).
fn flame_height(pile: u128, pct: u32, lit: bool) -> u32 {
    if pile == 0 {
        0
    } else if lit || pct >= 100 {
        14 + (pct.max(100) - 100) * 8 / 50
    } else {
        3 + pct * 9 / 100
    }
}

/// A teardrop of height `h` and half-width `w` with its base centred at (`x`, `base`).
fn flame(x: u32, base: u32, h: u32, w: u32, fill: &str) -> String {
    let top = base - h;
    let mid = base - h * 11 / 20;
    let (l, r) = (x - w, x + w);
    format!("<path d='M{x} {top}C{r} {mid} {r} {base} {x} {base}C{l} {base} {l} {mid} {x} {top}Z' fill='{fill}'/>")
}

pub fn draw(pile: u128, target: u128, outcome: Outcome, streak: u32, nights: &[Outcome]) -> String {
    let pct = if target == 0 { 150 } else { mul_div(pile, 100, target).min(150) as u32 };
    let smoky = matches!(outcome, Outcome::Smoked | Outcome::Cold);
    let h = flame_height(pile, pct, outcome == Outcome::Lit);
    let mut s = String::with_capacity(1_400);
    s.push_str("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>");
    s.push_str("<rect width='64' height='64' rx='14' fill='#1d1426'/>");
    let (word, size, color) = label(outcome, streak);
    s.push_str(&format!(
        "<text x='32' y='{}' text-anchor='middle' font-family='sans-serif' font-size='{size}' font-weight='700' fill='{color}'>{word}</text>",
        4 + size
    ));
    if h > 0 {
        let w = 4 + h / 3;
        let (outer, inner) = if smoky { ("#b4521f", "#e09a3a") } else { ("#ff7a1a", "#ffd23f") };
        s.push_str(&flame(32, 42, h, w, outer));
        s.push_str(&flame(32, 42, h * 3 / 5, w * 3 / 5, inner));
    } else {
        s.push_str("<g fill='#e0532a'><circle cx='27' cy='38' r='1.6'/><circle cx='32' cy='37' r='1.6'/><circle cx='37' cy='38' r='1.6'/></g>");
    }
    if smoky {
        let top = if h == 0 { 32 } else { 42 - h - 2 };
        s.push_str(&format!(
            "<g fill='#8f8c99' opacity='.8'><circle cx='28' cy='{}' r='4'/><circle cx='36' cy='{}' r='5'/></g>",
            top,
            top - 6
        ));
    }
    s.push_str("<path d='M19 47L45 40M19 40L45 47' stroke='#7b4a26' stroke-width='4' stroke-linecap='round'/>");
    for (i, o) in nights.iter().enumerate() {
        let x = 10 + i as u32 * 7;
        match o {
            Outcome::Lit => s.push_str(&flame(x, 59, 7, 3, "#ff7a1a")),
            Outcome::Smoked => s.push_str(&format!("<circle cx='{x}' cy='56' r='2.6' fill='#8f8c99'/>")),
            _ => s.push_str(&format!("<circle cx='{x}' cy='56' r='2' fill='none' stroke='#6c7a90'/>")),
        }
    }
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
