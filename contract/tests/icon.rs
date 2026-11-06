//! `ft_metadata().icon`: a valid, small SVG data URL that shows the fire.
mod common;

use common::*;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadataProvider;

fn icon(g: &mut Game) -> String {
    g.view(|c| c.ft_metadata()).icon.unwrap()
}

/// Checks the URL, percent-decodes it, and checks that the SVG is well-formed.
fn decode(url: &str) -> String {
    let data = url.strip_prefix("data:image/svg+xml,").expect("an SVG data URL");
    let ok = |b: u8| b.is_ascii_alphanumeric() || b"-_.!~*'()/:;=,%".contains(&b);
    assert!(data.bytes().all(ok), "a character that must be escaped in a URL");
    let bytes = data.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            out.push(u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap(), 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let svg = String::from_utf8(out).unwrap();
    assert!(svg.starts_with("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"));
    assert!(svg.ends_with("</svg>"));
    well_formed(&svg);
    svg
}

/// Every tag closes in order, every attribute value is quoted.
fn well_formed(svg: &str) {
    let mut stack: Vec<String> = Vec::new();
    let mut rest = svg;
    while let Some(start) = rest.find('<') {
        let end = rest[start..].find('>').expect("an unclosed tag") + start;
        let tag = &rest[start + 1..end];
        assert_eq!(tag.matches('\'').count() % 2, 0, "unbalanced quotes in <{tag}>");
        if let Some(name) = tag.strip_prefix('/') {
            assert_eq!(stack.pop().as_deref(), Some(name), "mismatched </{name}>");
        } else if !tag.ends_with('/') {
            stack.push(tag.split_whitespace().next().unwrap().to_string());
        }
        assert!(!rest[..start].contains('>'), "a stray '>'");
        rest = &rest[end + 1..];
    }
    assert!(stack.is_empty(), "unclosed: {stack:?}");
}

/// y of the flame's tip: the smaller, the taller the fire.
fn flame_top(svg: &str) -> Option<u32> {
    let at = svg.find("<path d='M32 ")? + "<path d='M32 ".len();
    svg[at..].split('C').next()?.parse().ok()
}

#[test]
fn the_icon_is_a_small_valid_svg_data_url() {
    let mut g = Game::new();
    let url = icon(&mut g);
    assert!(url.len() < 2_048, "{} bytes", url.len());
    let svg = decode(&url);
    assert!(svg.contains(">0</text>"), "streak 0 under the logs");
    assert!(flame_top(&svg).is_none(), "no wood yet, no flame: {svg}");
    eprintln!("icon: {} bytes as a data URL", url.len());
}

#[test]
fn a_lit_night_stands_tall_with_the_streak_written_under_it() {
    let mut g = Game::new();
    for _ in 0..3 {
        let t = g.state().target.0;
        g.throw(&founder(0), t * 3 / 2);
        g.next_night();
    }
    let svg = decode(&icon(&mut g));
    assert!(svg.contains(">3</text>"));
    assert!(!svg.contains("#8f8c99"), "no smoke after a lit night");
    assert!(svg.contains("#ff7a1a"));
    assert_eq!(flame_top(&svg), Some(10), "150% of the target is the tallest flame");
}

#[test]
fn a_smoky_night_is_a_low_flame_under_grey_smoke() {
    let mut g = Game::new();
    let t = g.state().target.0;
    g.throw(&founder(0), t);
    g.next_night();
    let lit = flame_top(&decode(&icon(&mut g))).unwrap();
    g.throw(&founder(0), t / 2);
    g.next_night();
    let svg = decode(&icon(&mut g));
    assert!(svg.contains("#8f8c99"), "grey smoke");
    assert!(svg.contains(">0</text>"), "the streak is broken");
    let smoky = flame_top(&svg).unwrap();
    assert!(smoky > lit, "the smoky flame ({smoky}) is lower than the lit one ({lit})");
    // An empty night: smoke over cold embers.
    g.next_night();
    let svg = decode(&icon(&mut g));
    assert!(svg.contains("#8f8c99") && flame_top(&svg).is_none());
}

#[test]
fn before_the_first_night_ends_the_icon_shows_tonight_s_pile() {
    let mut g = Game::new();
    g.throw(&founder(0), 10_000);
    let half = flame_top(&decode(&icon(&mut g))).unwrap();
    g.throw(&founder(1), 10_000);
    let full = flame_top(&decode(&icon(&mut g))).unwrap();
    assert!(full < half);
}
