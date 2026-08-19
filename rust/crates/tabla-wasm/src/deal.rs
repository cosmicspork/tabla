//! The deal, as the app sees it.
//!
//! A thin surface over [`tabla_deal`]. It belongs in this module rather than
//! the plugin module for the same reason everything else here does: it holds a
//! key. The game rules never see one — they are handed tile values that this
//! layer has already proven, exactly as they are already handed move bytes
//! whose signatures the log layer checked.
//!
//! Randomness comes from the caller, as everywhere else in this crate. Every
//! method that proves something takes 32 bytes of entropy, and TypeScript is
//! expected to supply fresh ones from `crypto.getRandomValues` each time.
//! Reusing them against the same deck reproduces the same shuffle.

use tabla_deal::{
    DealError, KeyShare,
    state::{DealState, Facts, Step},
};
use wasm_bindgen::prelude::*;

fn deal_err(e: DealError) -> JsError {
    JsError::new(&e.to_string())
}

/// What one entry made visible to this device.
///
/// Positions are indices into the deck, which is what the rules use to name a
/// tile — a rack is a list of positions, and the value at each is a fact this
/// layer supplies.
#[wasm_bindgen]
pub struct DealFacts {
    inner: Facts,
}

#[wasm_bindgen]
impl DealFacts {
    /// Positions newly readable here, as `[position, tile, position, tile, …]`.
    ///
    /// Flat rather than a list of pairs because that crosses the wasm boundary
    /// without allocating an object per tile.
    #[wasm_bindgen(getter)]
    pub fn mine(&self) -> Vec<u16> {
        self.inner
            .mine
            .iter()
            .flat_map(|&(position, tile)| [position, u16::from(tile)])
            .collect()
    }

    /// Positions the opponent can now read. Their contents stay hidden.
    #[wasm_bindgen(getter)]
    pub fn theirs(&self) -> Vec<u16> {
        self.inner.theirs.clone()
    }

    /// Positions opened to everyone, in the same flat shape as `mine`.
    #[wasm_bindgen(getter)]
    pub fn public(&self) -> Vec<u16> {
        self.inner
            .public
            .iter()
            .flat_map(|&(position, tile)| [position, u16::from(tile)])
            .collect()
    }

    /// Whether this entry completed the opening ceremony.
    #[wasm_bindgen(getter)]
    pub fn ready(&self) -> bool {
        self.inner.ready
    }
}

/// One device's half of a deal.
#[wasm_bindgen]
pub struct DealSession {
    inner: DealState,
}

#[wasm_bindgen]
impl DealSession {
    /// Starts a deal.
    ///
    /// `secret` is 64 bytes from `Identity.deriveDealSecret`. `tiles` is the
    /// bag in canonical order, which both players compute for themselves —
    /// it is public, and the shuffles are what make it a bag.
    #[wasm_bindgen(constructor)]
    pub fn new(
        game_id: &[u8],
        player: u8,
        secret: &[u8],
        tiles: &[u8],
        kinds: u8,
    ) -> Result<DealSession, JsError> {
        let game_id: [u8; 16] = game_id
            .try_into()
            .map_err(|_| JsError::new("gameId must be 16 bytes"))?;
        let secret: [u8; 64] = secret
            .try_into()
            .map_err(|_| JsError::new("the deal secret must be 64 bytes"))?;
        if player > 1 {
            return Err(JsError::new("player must be 0 or 1"));
        }

        Ok(Self {
            inner: DealState::new(
                game_id,
                player,
                KeyShare::from_wide_bytes(&secret),
                tiles,
                kinds,
            ),
        })
    }

    /// Restores a deal from a snapshot taken at a known point in the log.
    ///
    /// The caller must be sure the snapshot belongs to the log it is about to
    /// continue — see [`DealSession::snapshot`].
    #[wasm_bindgen]
    pub fn restore(
        game_id: &[u8],
        player: u8,
        secret: &[u8],
        kinds: u8,
        snapshot: &[u8],
    ) -> Result<DealSession, JsError> {
        let game_id: [u8; 16] = game_id
            .try_into()
            .map_err(|_| JsError::new("gameId must be 16 bytes"))?;
        let secret: [u8; 64] = secret
            .try_into()
            .map_err(|_| JsError::new("the deal secret must be 64 bytes"))?;

        Ok(Self {
            inner: DealState::load(
                game_id,
                player,
                KeyShare::from_wide_bytes(&secret),
                kinds,
                snapshot,
            )
            .map_err(deal_err)?,
        })
    }

    /// Consumes one entry's deal payload, verifying every proof inside it.
    ///
    /// Rejects leave the state untouched, so a caller can refuse the entry and
    /// carry on with the game it already had.
    #[wasm_bindgen(js_name = applyEntry)]
    pub fn apply_entry(
        &mut self,
        author: u8,
        seq: u32,
        payload: &[u8],
    ) -> Result<DealFacts, JsError> {
        let inner = self.inner.apply(author, seq, payload).map_err(deal_err)?;
        Ok(DealFacts { inner })
    }

    /// What this player still owes the opening ceremony: `key`, `shuffle`, or
    /// `play` once it is done.
    #[wasm_bindgen(getter)]
    pub fn step(&self) -> String {
        match self.inner.step() {
            Step::Key => "key",
            Step::Shuffle => "shuffle",
            Step::Play => "play",
        }
        .to_string()
    }

    /// Whether both players have published a key share and shuffled.
    #[wasm_bindgen(getter)]
    pub fn ready(&self) -> bool {
        self.inner.ready()
    }

    /// How many tiles have never been dealt.
    #[wasm_bindgen(getter)]
    pub fn remaining(&self) -> usize {
        self.inner.remaining()
    }

    /// Positions dealt to this player.
    #[wasm_bindgen(getter)]
    pub fn held(&self) -> Vec<u16> {
        self.inner.held()
    }

    /// The tile at a position this player can read, or `undefined`.
    #[wasm_bindgen]
    pub fn tile(&self, position: u16) -> Option<u8> {
        self.inner.tile(position)
    }

    /// Every position this player can read, as `[position, tile, …]`.
    ///
    /// What the rules are given: the rack, plus anything already public.
    #[wasm_bindgen(js_name = visibleTiles)]
    pub fn visible_tiles(&self) -> Vec<u16> {
        let mut out: Vec<u16> = Vec::new();
        for (&position, &tile) in self.inner.public_tiles() {
            out.push(position);
            out.push(u16::from(tile));
        }
        for position in self.inner.held() {
            if self.inner.public_tiles().contains_key(&position) {
                continue;
            }
            if let Some(tile) = self.inner.tile(position) {
                out.push(position);
                out.push(u16::from(tile));
            }
        }
        out
    }

    /// The state as bytes, so reopening a game need not re-verify its log.
    ///
    /// Only meaningful paired with the tip it was taken at. Restoring it
    /// against a different log would be nonsense, which is why the app stores
    /// the tip hash alongside and throws the snapshot away on a mismatch.
    #[wasm_bindgen]
    pub fn snapshot(&self) -> Vec<u8> {
        self.inner.save()
    }

    // -- building payloads ----------------------------------------------------

    /// This player's key share, with its proof of knowledge.
    #[wasm_bindgen(js_name = keyPayload)]
    pub fn key_payload(&self, seq: u32, entropy: &[u8]) -> Vec<u8> {
        self.inner.build(seq).key(entropy).finish()
    }

    /// A key share and a shuffle in one entry, for the player who does both.
    #[wasm_bindgen(js_name = keyAndShufflePayload)]
    pub fn key_and_shuffle_payload(&self, seq: u32, entropy: &[u8]) -> Vec<u8> {
        self.inner.build(seq).key(entropy).shuffle(entropy).finish()
    }

    /// A shuffle, optionally followed by the opponent's opening rack.
    #[wasm_bindgen(js_name = shufflePayload)]
    pub fn shuffle_payload(&self, seq: u32, deal: u16, entropy: &[u8]) -> Vec<u8> {
        let builder = self.inner.build(seq).shuffle(entropy);
        if deal == 0 {
            builder.finish()
        } else {
            builder.deal(deal, entropy).finish()
        }
    }

    /// Hands the opponent the next `count` tiles off the top of the deck.
    #[wasm_bindgen(js_name = dealPayload)]
    pub fn deal_payload(&self, seq: u32, count: u16, entropy: &[u8]) -> Vec<u8> {
        self.inner.build(seq).deal(count, entropy).finish()
    }

    /// Opens tiles this player holds, so everyone can read them.
    ///
    /// Used for a play, and for the final rack when the game ends.
    #[wasm_bindgen(js_name = revealPayload)]
    pub fn reveal_payload(&self, seq: u32, positions: &[u16], entropy: &[u8]) -> Vec<u8> {
        self.inner.build(seq).reveal(positions, entropy).finish()
    }

    /// Opens tiles and refills the opponent in one entry.
    ///
    /// The ordinary shape of a turn: show what was played, and hand over
    /// replacements for whatever the opponent spent last time.
    #[wasm_bindgen(js_name = revealAndDealPayload)]
    pub fn reveal_and_deal_payload(
        &self,
        seq: u32,
        positions: &[u16],
        count: u16,
        entropy: &[u8],
    ) -> Vec<u8> {
        let builder = self.inner.build(seq).reveal(positions, entropy);
        if count == 0 {
            builder.finish()
        } else {
            builder.deal(count, entropy).finish()
        }
    }
}
