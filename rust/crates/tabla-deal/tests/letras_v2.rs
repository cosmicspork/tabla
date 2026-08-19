//! The rules and the deal, wired together the way the app wires them.
//!
//! Everywhere else the two halves are tested apart: `tabla-letras` substitutes
//! a fake deck so it can say "play the word CAT", and this crate proves things
//! about ciphertexts without caring what game they belong to. This is the seam
//! itself — real proofs, real rules, and the cross-check between them that the
//! host is responsible for.
//!
//! The dependency points this way deliberately. `tabla-letras` must never reach
//! the curve code, not even as a dev-dependency, because a reader checking that
//! invariant should be able to see it in the dependency graph rather than
//! having to trust a feature flag. So the test that needs both lives here.
//!
//! ## What the host is for
//!
//! The rules cannot verify a decryption share; they link nothing that could.
//! The deal cannot tell a legal word from an illegal one. Between them sits a
//! host that must do three things in order, and this file is where that order
//! is pinned down:
//!
//! 1. Apply the entry's deal payload, which verifies every proof in it.
//! 2. Check that what the *move* claims matches what the deal actually opened.
//! 3. Only then let the rules apply the move.
//!
//! Skip step 2 and a player can name any tile they like while attaching a
//! perfectly valid payload about a different one. The last test here is that
//! attack, and it is caught by the host rather than by either half alone.

use tabla_deal::{KeyShare, state::DealState};
use tabla_letras::tiles::{TILE_TOTAL, Tile, distribution};
use tabla_letras::v2::game::{Action, Laid, Letras, Move, Private, State, config_for};
use tabla_plugin_api::{GamePlugin, PLAYER_CLAIMER, PLAYER_INITIATOR, PlayerId, PluginError};

const GAME: [u8; 16] = [0x77; 16];
const KINDS: u8 = 27;

const WORDS: [&str; 27] = [
    "at", "ate", "cat", "cats", "cot", "cots", "do", "dog", "dogs", "eat", "eats", "in", "into",
    "it", "no", "not", "on", "one", "so", "sat", "set", "ten", "tin", "to", "toe", "ton", "too",
];

/// The bag in canonical order — public, and what both players start from.
fn bag() -> Vec<Tile> {
    let counts = distribution();
    let mut tiles = Vec::with_capacity(TILE_TOTAL as usize);
    for (kind, &count) in counts.iter().enumerate() {
        for _ in 0..count {
            tiles.push(kind as Tile);
        }
    }
    tiles
}

fn key(player: u8) -> KeyShare {
    KeyShare::from_wide_bytes(&[0x40 + player; 64])
}

fn entropy(n: u8) -> [u8; 32] {
    [n; 32]
}

/// One device: its deal, and the rules replayed on top of it.
struct Client {
    deal: DealState,
    player: PlayerId,
}

impl Client {
    fn new(player: PlayerId) -> Self {
        Self {
            deal: DealState::new(GAME, player, key(player), &bag(), KINDS),
            player,
        }
    }

    /// What this device knows privately: everything the deal has opened to it.
    fn private(&self) -> Private {
        let mut tiles: Vec<(u16, Tile)> = self
            .deal
            .held()
            .iter()
            .filter_map(|&position| self.deal.tile(position).map(|tile| (position, tile)))
            .collect();
        for (&position, &tile) in self.deal.public_tiles() {
            tiles.push((position, tile));
        }
        tiles.sort_unstable();
        tiles.dedup();

        Private {
            player: self.player,
            tiles,
        }
    }
}

/// Both devices and the log between them.
struct Table {
    initiator: Client,
    claimer: Client,
    moves: Vec<Move>,
    assets: Vec<u8>,
    config: Vec<u8>,
}

impl Table {
    fn new() -> Self {
        let mut sorted: Vec<&str> = WORDS.to_vec();
        sorted.sort_unstable();
        let assets = tabla_dawg::build::compile(&sorted).expect("the test word list compiles");

        let hash: [u8; 32] = {
            use sha2::{Digest, Sha256};
            Sha256::digest(&assets).into()
        };

        Self {
            initiator: Client::new(PLAYER_INITIATOR),
            claimer: Client::new(PLAYER_CLAIMER),
            moves: Vec::new(),
            assets,
            config: config_for(&hash),
        }
    }

    fn to_move(&self) -> PlayerId {
        (self.moves.len() % 2) as PlayerId
    }

    /// The sequence number this entry would occupy. Play starts at 2.
    fn seq(&self) -> u32 {
        self.moves.len() as u32 + 2
    }

    fn client(&self, who: PlayerId) -> &Client {
        if who == PLAYER_INITIATOR {
            &self.initiator
        } else {
            &self.claimer
        }
    }

    fn client_mut(&mut self, who: PlayerId) -> &mut Client {
        if who == PLAYER_INITIATOR {
            &mut self.initiator
        } else {
            &mut self.claimer
        }
    }

    /// The rules as one device sees them, rebuilt from the log.
    fn state(&self, who: PlayerId) -> State {
        let private = self.client(who).private().encode();
        let mut state =
            Letras::setup(&self.config, &private, &self.assets).expect("setup succeeds");

        for (index, mv) in self.moves.iter().enumerate() {
            let mover = (index % 2) as PlayerId;
            state = Letras::apply_move(state, mv, &self.assets).expect("a replayed move applies");
            let _ = mover;
        }
        state
    }

    fn view(&self, who: PlayerId) -> tabla_letras::v2::game::View {
        Letras::player_view(&self.state(who), who)
    }

    /// Submits one entry, doing everything a host must do and in that order.
    fn submit(&mut self, action: Action, payload: Option<Vec<u8>>) -> Result<(), PluginError> {
        let who = self.to_move();
        let seq = self.seq();
        let mv = Move {
            action: action.clone(),
            deal: payload.clone(),
        };

        // 1. The rules refuse an illegal move before anything is committed.
        Letras::validate_move(&self.state(who), &mv, who, &self.assets)?;
        Letras::validate_move(&self.state(1 - who), &mv, who, &self.assets)?;

        // 2. Both devices verify the deal payload. Either rejecting it means
        //    the entry does not happen.
        if let Some(payload) = &payload {
            for device in [PLAYER_INITIATOR, PLAYER_CLAIMER] {
                self.client_mut(device)
                    .deal
                    .apply(who, seq, payload)
                    .map_err(|_| PluginError::BadMove)?;
            }
        }

        // 3. And the claims in the move must match what the deal opened.
        self.cross_check(&action)?;

        self.moves.push(mv);
        self.agree();
        Ok(())
    }

    /// The host's own check: a tile named in a move must be one the deal opened.
    ///
    /// Neither half can do this alone, which is exactly why it is easy to leave
    /// out and worth a test of its own.
    fn cross_check(&self, action: &Action) -> Result<(), PluginError> {
        let opened = self.initiator.deal.public_tiles();

        let claims: Vec<(u16, Tile)> = match action {
            Action::Place { placements } => placements
                .iter()
                .map(|laid| (laid.position, laid.tile))
                .collect(),
            Action::OpenRack { tiles } => tiles.clone(),
            _ => return Ok(()),
        };

        for (position, tile) in claims {
            match opened.get(&position) {
                Some(&actual) if actual == tile => {}
                _ => return Err(PluginError::BadMove),
            }
        }
        Ok(())
    }

    fn agree(&self) {
        let a = self.view(PLAYER_INITIATOR);
        let b = self.view(PLAYER_CLAIMER);

        assert_eq!(a.board, b.board, "boards diverged");
        assert_eq!(a.scores, b.scores, "scores diverged");
        assert_eq!(a.bag, b.bag, "bags diverged");
        assert_eq!(a.phase, b.phase, "phases diverged");
        assert_eq!(a.outcome, b.outcome, "outcomes diverged");
    }

    /// Whatever the rules say to submit, with the payload it needs attached.
    fn play_automatic(&mut self) {
        let who = self.to_move();
        let view = self.view(who);
        let seq = self.seq();
        let action = view.auto.expect("the rules asked for an automatic move");

        // Two sources, and neither knows what the other knows: the deal says
        // what the ceremony still owes, the rules say how many tiles to hand
        // over and what to open. The host is the only thing holding both.
        let payload = match &action {
            Action::OpenRack { .. } => Some(
                self.client(who)
                    .deal
                    .build(seq)
                    .reveal(&view.to_open, &entropy(0x44))
                    .finish(),
            ),
            _ => self.ceremony_payload(who, seq, view.owed),
        };

        self.submit(action, payload)
            .expect("a protocol move applies");
    }

    /// Whatever this entry owes: a key share, a shuffle, a refill, or nothing.
    ///
    /// `Step` comes from the deal and `owed` from the rules. Assembling them is
    /// exactly the host's job, and doing it in one place here is what the app
    /// does in `game-session`.
    fn ceremony_payload(&self, who: PlayerId, seq: u32, owed: u16) -> Option<Vec<u8>> {
        use tabla_deal::state::Step;

        let deal = &self.client(who).deal;
        let mut builder = deal.build(seq);
        let mut anything = false;

        match deal.step() {
            Step::Key => {
                builder = builder.key(&entropy(0x11));
                anything = true;
                // The claimer publishes its key and shuffles in one entry; the
                // builder knows the key it is about to publish counts.
                if deal.ready_for_shuffle_after_key() {
                    builder = builder.shuffle(&entropy(0x22));
                }
            }
            Step::Shuffle => {
                builder = builder.shuffle(&entropy(0x22));
                anything = true;
            }
            Step::Play => {}
        }

        if owed > 0 {
            builder = builder.deal(owed, &entropy(0x55));
            anything = true;
        }

        anything.then(|| builder.finish())
    }

    /// A play, opening the tiles it spends and refilling the opponent.
    fn place(&mut self, placements: Vec<Laid>) -> Result<(), PluginError> {
        let who = self.to_move();
        let seq = self.seq();
        let owed = self.view(who).owed;
        let positions: Vec<u16> = placements.iter().map(|laid| laid.position).collect();

        let builder = self
            .client(who)
            .deal
            .build(seq)
            .reveal(&positions, &entropy(0x66));
        let payload = if owed > 0 {
            builder.deal(owed, &entropy(0x66)).finish()
        } else {
            builder.finish()
        };

        self.submit(Action::Place { placements }, Some(payload))
    }

    /// A pass, which still refills whatever the opponent is owed.
    fn pass(&mut self) -> Result<(), PluginError> {
        let who = self.to_move();
        let seq = self.seq();
        let owed = self.view(who).owed;
        let payload = self.ceremony_payload(who, seq, owed);
        self.submit(Action::Pass, payload)
    }

    /// Runs the opening ceremony.
    fn open(&mut self) {
        self.play_automatic(); // initiator: key
        self.play_automatic(); // claimer: key
        self.play_automatic(); // initiator: shuffle, and the claimer's rack
        self.play_automatic(); // claimer: the initiator's rack

        if self.view(self.to_move()).auto == Some(Action::Yield) {
            self.play_automatic();
        }
    }

    /// The first `count` tiles of the mover's rack, across the centre row.
    fn rack_placements(&self, count: usize) -> Vec<Laid> {
        self.rack_placements_at(7, count)
    }

    /// The same, on a chosen row. Later plays need somewhere free to go.
    fn rack_placements_at(&self, row: u8, count: usize) -> Vec<Laid> {
        let view = self.view(self.to_move());
        view.rack
            .bytes()
            .zip(&view.rack_positions)
            .take(count)
            .enumerate()
            .map(|(i, (byte, &position))| Laid {
                position,
                row,
                col: 7 + i as u8,
                tile: if byte == b'?' {
                    0
                } else {
                    tabla_letras::tiles::tile_of(byte).expect("rack letters")
                },
                blank_as: (byte == b'?').then_some(tabla_letras::tiles::tile_of(b'e').unwrap()),
            })
            .collect()
    }
}

#[test]
fn a_real_deal_produces_two_racks_of_real_tiles() {
    let mut table = Table::new();
    table.open();

    let initiator = table.view(PLAYER_INITIATOR);
    let claimer = table.view(PLAYER_CLAIMER);

    assert_eq!(initiator.rack.chars().count(), 7);
    assert_eq!(claimer.rack.chars().count(), 7);
    assert_eq!(initiator.bag, u16::from(TILE_TOTAL) - 14);

    // Every dealt tile came out of the bag, and the racks do not overlap.
    let mut counts = distribution();
    for tile in initiator.rack.bytes().chain(claimer.rack.bytes()) {
        let kind = if tile == b'?' {
            0
        } else {
            tabla_letras::tiles::tile_of(tile).expect("a real letter") as usize
        };
        assert!(counts[kind] > 0, "more copies of a tile than the bag holds");
        counts[kind] -= 1;
    }
    assert!(
        initiator
            .rack_positions
            .iter()
            .all(|p| !claimer.rack_positions.contains(p))
    );
}

#[test]
fn neither_player_can_read_the_others_rack() {
    // The whole point of the deck. Each device holds the opponent's positions
    // as public knowledge and their contents as nothing at all.
    let mut table = Table::new();
    table.open();

    for (me, them) in [
        (PLAYER_INITIATOR, PLAYER_CLAIMER),
        (PLAYER_CLAIMER, PLAYER_INITIATOR),
    ] {
        let theirs = table.view(them).rack_positions.clone();
        for position in theirs {
            assert_eq!(
                table.client(me).deal.tile(position),
                None,
                "player {me} could read position {position}"
            );
        }
    }
}

#[test]
fn a_play_opens_its_tiles_to_both_devices() {
    let mut table = Table::new();
    table.open();

    let mover = table.to_move();
    let placements = table.rack_placements(2);
    let positions: Vec<u16> = placements.iter().map(|laid| laid.position).collect();

    // Before: only the holder can read them.
    assert!(table.client(1 - mover).deal.tile(positions[0]).is_none());

    table.place(placements).expect("a play from one's own rack");

    // After: both can, and they agree.
    for position in &positions {
        let mine = table.client(mover).deal.tile(*position);
        let theirs = table.client(1 - mover).deal.tile(*position);
        assert!(mine.is_some());
        assert_eq!(mine, theirs);
    }
}

#[test]
fn a_refill_arrives_on_the_opponents_next_entry() {
    // The rule that makes all of this work without both players being online:
    // the shares that replace a spent tile ride the entry the opponent was
    // going to write anyway, after the play is already public.
    let mut table = Table::new();
    table.open();

    let mover = table.to_move();
    table.place(table.rack_placements(3)).expect("a play");

    assert_eq!(table.view(mover).rack_positions.len(), 4);
    assert_eq!(table.view(1 - mover).owed, 3);

    table.pass().expect("the opponent passes and refills");

    assert_eq!(table.view(mover).rack_positions.len(), 7);
    assert_eq!(table.view(1 - mover).owed, 0);
}

#[test]
fn a_forged_share_is_refused_and_the_game_does_not_move() {
    let mut table = Table::new();
    table.open();

    let who = table.to_move();
    let seq = table.seq();
    let mut payload = table
        .client(who)
        .deal
        .build(seq)
        .deal(1, &entropy(0x99))
        .finish();

    // Damage the proof rather than the share, so the bytes still parse.
    let last = payload.len() - 1;
    payload[last] ^= 0x01;

    let before = table.moves.len();
    assert!(table.submit(Action::Pass, Some(payload)).is_err());
    assert_eq!(table.moves.len(), before, "a refused entry still landed");
}

#[test]
fn a_player_cannot_name_a_tile_the_deal_did_not_open() {
    // The attack the host's cross-check exists for: a valid payload opening one
    // tile, attached to a move claiming a different one. Neither the rules nor
    // the deal catches this alone — the rules cannot check cryptography, and the
    // deal has never heard of a Q.
    let mut table = Table::new();
    table.open();

    let who = table.to_move();
    let seq = table.seq();
    let mut placements = table.rack_placements(1);

    // A real opening for the position being played...
    let positions: Vec<u16> = placements.iter().map(|laid| laid.position).collect();
    let payload = table
        .client(who)
        .deal
        .build(seq)
        .reveal(&positions, &entropy(0x66))
        .finish();

    // ...and a move that lies about what is in it.
    let honest = placements[0].tile;
    placements[0].tile = if honest == 1 { 2 } else { 1 };
    placements[0].blank_as = None;

    let before = table.moves.len();
    let result = table.submit(Action::Place { placements }, Some(payload));

    assert!(result.is_err(), "a false claim was accepted");
    assert_eq!(table.moves.len(), before);
}

#[test]
fn both_devices_reach_the_same_position_from_the_same_log() {
    let mut table = Table::new();
    table.open();

    table.place(table.rack_placements(2)).expect("a play");
    table.pass().expect("a pass");
    table
        .place(table.rack_placements_at(8, 2))
        .expect("another play, on the row below");
    table.pass().expect("another pass");

    let a = table.view(PLAYER_INITIATOR);
    let b = table.view(PLAYER_CLAIMER);

    assert_eq!(a.board, b.board);
    assert_eq!(a.scores, b.scores);
    assert_eq!(a.bag, b.bag);
    assert_eq!(a.rack_positions.len(), b.opponent_tiles as usize);
    assert_eq!(b.rack_positions.len(), a.opponent_tiles as usize);
}
