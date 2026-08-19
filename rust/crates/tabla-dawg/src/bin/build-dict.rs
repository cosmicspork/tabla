//! Compiles a plain word list into the binary form the game reads.
//!
//! ```text
//! cargo run -p tabla-dawg --features build --bin build-dict -- words.txt out.dawg
//! ```
//!
//! Deliberately dumb: no filtering, no case folding, no "helpful" cleanup. The
//! input file is the published word list and the provenance note beside it says
//! exactly what it is; anything this tool silently changed would make that note
//! a lie. Words that are not lowercase `a`..=`z` are an error, not a warning.

use std::io::Write;

use tabla_dawg::build::compile;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(input), Some(output)) = (args.next(), args.next()) else {
        eprintln!("usage: build-dict <words.txt> <out.dawg>");
        std::process::exit(2);
    };

    let text = std::fs::read_to_string(&input)?;
    let words: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();

    let bytes = compile(&words)?;

    let mut file = std::fs::File::create(&output)?;
    file.write_all(&bytes)?;

    eprintln!(
        "{} words -> {} ({} bytes, {:.1} bits per word)",
        words.len(),
        output,
        bytes.len(),
        (bytes.len() as f64 * 8.0) / words.len() as f64,
    );
    Ok(())
}
