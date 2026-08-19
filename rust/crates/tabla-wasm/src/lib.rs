//! Placeholder for the wasm-bindgen surface (milestone 5).

use wasm_bindgen::prelude::*;

/// Protocol version this build speaks. Clients refuse to interoperate across
/// a mismatch, since divergent validation mid-game is unrecoverable.
#[wasm_bindgen]
pub fn protocol_version() -> u32 {
    1
}
