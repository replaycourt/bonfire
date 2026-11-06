//! `ft_metadata().icon`: a valid, small SVG data URL that shows the last night and the last seven.
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

/// y of the main flame's tip (the smaller, the taller), if there is a flame.
fn flame_top(svg: &str) -> Option<u32> {
    let at = svg.find("<path d='M32 ")? + "<path d='M32 ".len();
    svg[at..].split('C').next()?.parse().ok()
}

/// The word at the top and its font size.
fn label(svg: &str) -> (String, u32) {
    let text = &svg[svg.find("<text").unwrap()..];
    let at = text.find("font-size='").unwrap() + "font-size='".len();
    let size = text[at..].split('\'').next().unwrap().parse().unwrap();
    let word = text[text.find("'>").unwrap() + 2..text.find("</text>").unwrap()].to_string();
    (word, size)
}

/// The bottom row, oldest first: 'L' lit, 'S' smoked, 'C' cold.
fn row(svg: &str) -> String {
    let mut marks: Vec<(u32, char)> = Vec::new();
    for i in 0..7u32 {
        let x = 10 + i * 7;
        if svg.contains(&format!("<path d='M{x} 52C")) {
            marks.push((x, 'L'));
        } else if svg.contains(&format!("<circle cx='{x}' cy='56' r='2.6'")) {
            marks.push((x, 'S'));
        } else if svg.contains(&format!("<circle cx='{x}' cy='56' r='2' fill='none'")) {
            marks.push((x, 'C'));
        }
    }
    marks.into_iter().map(|m| m.1).collect()
}

fn light(g: &mut Game) {
    let t = g.state().target.0;
    g.throw(&founder(0), t * 3 / 2);
    g.next_night();
}

#[test]
fn the_icon_is_a_small_valid_svg_data_url() {
    let mut g = Game::new();
    let url = icon(&mut g);
    let svg = decode(&url);
    assert_eq!(label(&svg).0, "FIRST NIGHT");
    assert!(flame_top(&svg).is_none(), "no wood yet, no flame");
    assert_eq!(row(&svg), "");
    for _ in 0..7 {
        light(&mut g);
    }
    let url = icon(&mut g);
    assert!(url.len() < 3_000, "{} bytes", url.len());
    eprintln!("icon with seven lit nights: {} bytes as a data URL", url.len());
}

#[test]
fn a_lit_streak_stands_tall_and_its_word_grows_with_it() {
    let mut g = Game::new();
    for _ in 0..3 {
        light(&mut g);
    }
    let svg = decode(&icon(&mut g));
    assert_eq!(label(&svg), ("LIT \u{00d7}3".to_string(), 9));
    assert_eq!(flame_top(&svg), Some(20), "150% of the target is the tallest flame");
    assert!(!svg.contains("#8f8c99' opacity"), "no smoke after a lit night");
    assert_eq!(row(&svg), "LLL");
    for _ in 0..12 {
        light(&mut g);
    }
    let svg = decode(&icon(&mut g));
    assert_eq!(label(&svg), ("LIT \u{00d7}15".to_string(), 13));
    assert_eq!(row(&svg), "LLLLLLL", "the last seven nights only");
}

#[test]
fn smoked_and_cold_nights_show_smoke_and_their_words() {
    let mut g = Game::new();
    light(&mut g);
    let t = g.state().target.0;
    g.throw(&founder(0), t / 2);
    g.next_night();
    let svg = decode(&icon(&mut g));
    assert_eq!(label(&svg).0, "SMOKED");
    assert!(svg.contains("#8f8c99' opacity"), "grey smoke");
    let smoky = flame_top(&svg).unwrap();
    assert!(smoky > 20 + 10, "a low flame");
    g.next_night();
    let svg = decode(&icon(&mut g));
    assert_eq!(label(&svg).0, "COLD");
    assert!(flame_top(&svg).is_none());
    assert_eq!(row(&svg), "LSC");
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
