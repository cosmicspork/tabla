//! The deal as a state machine, advanced one log entry at a time.
//!
//! Everything else in this crate proves one thing in isolation. This is what
//! turns those proofs into a deal: it holds the deck, remembers who has been
//! given access to which positions, and refuses any entry that does not follow
//! from the ones before it.
//!
//! The soundness of the whole scheme is inductive and lives here. A shuffle
//! proof says "this deck is a permutation of *that* deck" — worth nothing
//! unless someone insists that "that deck" is the one actually in play. A
//! decryption share is meaningless without the key share it must match, which
//! was published entries earlier. Losing track of either is how a proof system
//! ends up proving nothing, so the checks are stated plainly and tested for
//! their absence.
//!
//! ## The shape of a deal
//!
//! Both players publish a key share. Both shuffle, in turn. From then on the
//! deck is dealt from the top: to give the opponent a tile, a player publishes
//! their own decryption share for the next position, which only the opponent
//! can combine with theirs. To show a tile to everyone — playing it, or opening
//! a rack at the end — its holder publishes their share too, and with both in
//! the log anyone can read it.
//!
//! ## What this module does not decide
//!
//! Whose turn it is, what a rack is, when a tile is spent, or whether a word is
//! a word. Those are rules, they live in the game plugin, and it has no
//! cryptography in it at all. This module answers only: is this a legal move of
//! the *deal*, and what did it make visible?

use std::collections::BTreeMap;

use curve25519_dalek::RistrettoPoint;

use crate::{
    Ciphertext, DealError, KeyShare, POINT_LEN, PublicShare, Transcript,
    encoding::{point_from_bytes, put_point},
    generators,
    proofs::{EQUALITY_PROOF_LEN, EqualityProof, KNOWLEDGE_PROOF_LEN, KnowledgeProof},
    shuffle::{self, ShuffleProof},
};

/// Transcript label for everything the deal proves.
const DEAL_LABEL: &[u8] = b"deal";

const PART_KEY: u8 = 1;
const PART_SHUFFLE: u8 = 2;
const PART_DEAL: u8 = 3;
const PART_REVEAL: u8 = 4;

const SNAPSHOT_VERSION: u8 = 1;

/// What a player learned from one entry.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// Positions this device can now read, with the tiles in them.
    pub mine: Vec<(u16, u8)>,
    /// Positions the opponent can now read. Their contents stay hidden here.
    pub theirs: Vec<u16>,
    /// Positions now open to everyone, with the tiles in them.
    pub public: Vec<(u16, u8)>,
    /// Whether this entry completed the opening ceremony.
    pub ready: bool,
}

/// What the protocol is waiting for next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// This player has not published a key share.
    Key,
    /// This player has not shuffled.
    Shuffle,
    /// The ceremony is done; the deal follows the game.
    Play,
}

/// One player's view of the deal.
pub struct DealState {
    game_id: [u8; 16],
    me: u8,
    key: KeyShare,
    kinds: u8,

    public_shares: [Option<PublicShare>; 2],
    shuffled: [bool; 2],
    deck: Vec<Ciphertext>,
    pointer: u32,

    /// Which player was given access to each dealt position.
    dealt: BTreeMap<u16, u8>,
    /// Every decryption share published, by position and whose it is.
    shares: BTreeMap<(u16, u8), RistrettoPoint>,
    /// Positions both players have opened, and what was in them.
    public: BTreeMap<u16, u8>,
}

impl DealState {
    /// Starts a deal over a deck both players can compute for themselves.
    ///
    /// `tiles` is the bag in canonical order. It is public — the starting deck
    /// hides nothing, and costs no bytes in the log for that reason. The first
    /// shuffle is what makes it a bag.
    pub fn new(game_id: [u8; 16], me: u8, key: KeyShare, tiles: &[u8], kinds: u8) -> Self {
        Self {
            game_id,
            me,
            key,
            kinds,
            public_shares: [None, None],
            shuffled: [false, false],
            deck: tiles
                .iter()
                .map(|&kind| Ciphertext::trivial(&generators::tile_point(kind)))
                .collect(),
            pointer: 0,
            dealt: BTreeMap::new(),
            shares: BTreeMap::new(),
            public: BTreeMap::new(),
        }
    }

    /// What this player still owes the ceremony.
    pub fn step(&self) -> Step {
        if self.public_shares[self.me as usize].is_none() {
            Step::Key
        } else if self.public_shares.iter().all(Option::is_some) && !self.shuffled[self.me as usize]
        {
            Step::Shuffle
        } else {
            Step::Play
        }
    }

    /// Whether publishing our key share now would let us shuffle in the same
    /// entry.
    ///
    /// True for the second player to speak: their key completes the joint key,
    /// so the shuffle that follows it has something to re-randomise under. It
    /// saves the ceremony an entry, and an entry is a turn.
    pub fn ready_for_shuffle_after_key(&self) -> bool {
        self.public_shares[self.me as usize].is_none()
            && self.public_shares[1 - self.me as usize].is_some()
            && !self.shuffled[self.me as usize]
    }

    /// Whether both players have published a key share and shuffled.
    pub fn ready(&self) -> bool {
        self.public_shares.iter().all(Option::is_some) && self.shuffled.iter().all(|&done| done)
    }

    /// How many positions have never been dealt.
    pub fn remaining(&self) -> usize {
        self.deck.len() - self.pointer as usize
    }

    /// The next position that would be dealt.
    pub fn pointer(&self) -> u32 {
        self.pointer
    }

    /// The tile at a position this player can read, if any.
    pub fn tile(&self, position: u16) -> Option<u8> {
        if let Some(&tile) = self.public.get(&position) {
            return Some(tile);
        }
        if self.dealt.get(&position) != Some(&self.me) {
            return None;
        }
        self.open_for_me(position)
    }

    /// Positions dealt to this player that only this player can read.
    pub fn held(&self) -> Vec<u16> {
        self.dealt
            .iter()
            .filter(|(_, who)| **who == self.me)
            .map(|(position, _)| *position)
            .collect()
    }

    /// Tiles opened to everyone, by position.
    pub fn public_tiles(&self) -> &BTreeMap<u16, u8> {
        &self.public
    }

    // -- applying -------------------------------------------------------------

    /// Consumes one entry's deal payload.
    ///
    /// Every proof inside is verified against the state as it stands, and the
    /// state advances only if all of them hold. A rejected payload leaves the
    /// state untouched, so a caller can refuse the entry and carry on.
    pub fn apply(&mut self, author: u8, seq: u32, payload: &[u8]) -> Result<Facts, DealError> {
        // Work on a copy: a payload with three good parts and a bad fourth must
        // not leave three of them applied.
        let mut draft = self.snapshot();
        let facts = self.apply_to(&mut draft, author, seq, payload)?;
        self.restore_from(&draft)?;
        Ok(facts)
    }

    fn apply_to(
        &self,
        draft: &mut Snapshot,
        author: u8,
        seq: u32,
        payload: &[u8],
    ) -> Result<Facts, DealError> {
        if author > 1 {
            return Err(DealError::OutOfRange);
        }

        let mut transcript = Transcript::new(DEAL_LABEL, &self.game_id, seq);
        let mut facts = Facts::default();
        let was_ready = draft.ready();

        let (count, mut rest) = take_u8(payload)?;
        for _ in 0..count {
            let (kind, tail) = take_u8(rest)?;
            rest = match kind {
                PART_KEY => self.apply_key(draft, &mut transcript, author, tail)?,
                PART_SHUFFLE => self.apply_shuffle(draft, &mut transcript, author, tail)?,
                PART_DEAL => self.apply_deal(draft, &mut transcript, author, tail, &mut facts)?,
                PART_REVEAL => {
                    self.apply_reveal(draft, &mut transcript, author, tail, &mut facts)?
                }
                _ => return Err(DealError::BadEncoding),
            };
        }

        facts.ready = !was_ready && draft.ready();
        Ok(facts)
    }

    fn apply_key<'a>(
        &self,
        draft: &mut Snapshot,
        transcript: &mut Transcript,
        author: u8,
        bytes: &'a [u8],
    ) -> Result<&'a [u8], DealError> {
        // One key share each, published once. Without this a player could
        // replace their share after seeing the opponent's and steer the joint
        // key wherever they liked.
        if draft.public_shares[author as usize].is_some() {
            return Err(DealError::BadProof);
        }
        if bytes.len() < POINT_LEN + KNOWLEDGE_PROOF_LEN {
            return Err(DealError::Truncated);
        }

        let share = PublicShare::from_bytes(&bytes[..POINT_LEN])?;
        let proof = KnowledgeProof::from_bytes(&bytes[POINT_LEN..])?;

        // The proof of knowledge is what stops a rogue key: a player who could
        // publish a share they cannot open would control the sum of the two.
        proof.verify(transcript, &share.0)?;

        draft.public_shares[author as usize] = Some(share);
        Ok(&bytes[POINT_LEN + KNOWLEDGE_PROOF_LEN..])
    }

    fn apply_shuffle<'a>(
        &self,
        draft: &mut Snapshot,
        transcript: &mut Transcript,
        author: u8,
        bytes: &'a [u8],
    ) -> Result<&'a [u8], DealError> {
        let key = draft.joint_key().ok_or(DealError::BadProof)?;
        if draft.shuffled[author as usize] {
            return Err(DealError::BadProof);
        }
        // Shuffling after tiles have been dealt would re-order positions
        // already spoken for.
        if draft.pointer > 0 {
            return Err(DealError::BadProof);
        }

        let n = draft.deck.len();
        let deck_bytes = n * crate::CIPHERTEXT_LEN;
        if bytes.len() < deck_bytes + shuffle::proof_len(n) {
            return Err(DealError::Truncated);
        }

        let mut deck = Vec::with_capacity(n);
        for i in 0..n {
            deck.push(Ciphertext::from_bytes(&bytes[i * crate::CIPHERTEXT_LEN..])?);
        }
        let proof = ShuffleProof::from_bytes(&bytes[deck_bytes..], n)?;

        // Against the deck as it stands, which is the whole inductive step.
        proof.verify(transcript, &draft.deck, &deck, &key)?;

        draft.deck = deck;
        draft.shuffled[author as usize] = true;
        Ok(&bytes[deck_bytes + shuffle::proof_len(n)..])
    }

    fn apply_deal<'a>(
        &self,
        draft: &mut Snapshot,
        transcript: &mut Transcript,
        author: u8,
        bytes: &'a [u8],
        facts: &mut Facts,
    ) -> Result<&'a [u8], DealError> {
        if !draft.ready() {
            return Err(DealError::BadProof);
        }

        let (count, mut rest) = take_u16(bytes)?;
        let recipient = 1 - author;

        for index in 0..count {
            let (published, tail) = take_share(rest)?;
            let position = published.position;

            // Dealing is strictly from the top of the deck. A player who could
            // choose positions could deal from anywhere they had learned about.
            if u32::from(position) != draft.pointer {
                return Err(DealError::OutOfRange);
            }
            if draft.pointer as usize >= draft.deck.len() {
                return Err(DealError::OutOfRange);
            }

            self.check_share(draft, transcript, author, &published, index)?;

            draft.shares.insert((position, author), published.share);
            draft.dealt.insert(position, recipient);
            draft.pointer += 1;

            if recipient == self.me {
                let tile = self
                    .open_with(draft, position, &published.share)
                    .ok_or(DealError::NotATile)?;
                facts.mine.push((position, tile));
            } else {
                facts.theirs.push(position);
            }

            rest = tail;
        }

        Ok(rest)
    }

    fn apply_reveal<'a>(
        &self,
        draft: &mut Snapshot,
        transcript: &mut Transcript,
        author: u8,
        bytes: &'a [u8],
        facts: &mut Facts,
    ) -> Result<&'a [u8], DealError> {
        let (count, mut rest) = take_u16(bytes)?;

        for index in 0..count {
            let (published, tail) = take_share(rest)?;
            let position = published.position;

            // Only the holder can open a tile, and only once.
            if draft.dealt.get(&position) != Some(&author) {
                return Err(DealError::OutOfRange);
            }
            if draft.public.contains_key(&position) {
                return Err(DealError::OutOfRange);
            }

            self.check_share(draft, transcript, author, &published, index)?;

            let other = draft
                .shares
                .get(&(position, 1 - author))
                .copied()
                .ok_or(DealError::BadProof)?;
            let ciphertext = draft.deck[position as usize];
            let opened = ciphertext.open([&published.share, &other]);
            let tile = generators::tile_of(&opened, self.kinds).ok_or(DealError::NotATile)?;

            draft.shares.insert((position, author), published.share);
            draft.public.insert(position, tile);
            facts.public.push((position, tile));

            rest = tail;
        }

        Ok(rest)
    }

    /// Checks one decryption share against the key its author published.
    fn check_share(
        &self,
        draft: &Snapshot,
        transcript: &mut Transcript,
        author: u8,
        published: &Published,
        index: u16,
    ) -> Result<(), DealError> {
        let ciphertext = draft
            .deck
            .get(published.position as usize)
            .ok_or(DealError::OutOfRange)?;
        let public = draft.public_shares[author as usize].ok_or(DealError::BadProof)?;

        transcript.absorb_u32(b"deal-position", u32::from(published.position));
        transcript.absorb_u32(b"deal-index", u32::from(index));
        published
            .proof
            .verify(transcript, &public.0, &ciphertext.c1, &published.share)
    }

    fn open_for_me(&self, position: u16) -> Option<u8> {
        let other = self.shares.get(&(position, 1 - self.me))?;
        let ciphertext = self.deck.get(position as usize)?;
        let mine = self.key.decryption_share(ciphertext);
        generators::tile_of(&ciphertext.open([&mine, other]), self.kinds)
    }

    fn open_with(&self, draft: &Snapshot, position: u16, other: &RistrettoPoint) -> Option<u8> {
        let ciphertext = draft.deck.get(position as usize)?;
        let mine = self.key.decryption_share(ciphertext);
        generators::tile_of(&ciphertext.open([&mine, other]), self.kinds)
    }

    // -- building -------------------------------------------------------------

    /// Starts a payload for the entry at `seq`.
    pub fn build(&self, seq: u32) -> PayloadBuilder<'_> {
        PayloadBuilder {
            state: self,
            transcript: Transcript::new(DEAL_LABEL, &self.game_id, seq),
            parts: Vec::new(),
            count: 0,
            pointer: self.pointer,
            deck: None,
            pending_key: None,
        }
    }

    // -- persistence ----------------------------------------------------------

    /// The state as bytes, so a device need not re-verify a log it has read.
    ///
    /// Verification is monotone — an entry accepted once stays accepted — so a
    /// snapshot taken at a known tip is as good as the work that produced it.
    /// The caller is responsible for pairing it with that tip; a snapshot
    /// restored against a different log would be nonsense.
    pub fn save(&self) -> Vec<u8> {
        self.snapshot().encode()
    }

    /// Restores a saved state. The key share is supplied again, never stored.
    pub fn load(
        game_id: [u8; 16],
        me: u8,
        key: KeyShare,
        kinds: u8,
        bytes: &[u8],
    ) -> Result<Self, DealError> {
        let snapshot = Snapshot::decode(bytes)?;
        Ok(Self {
            game_id,
            me,
            key,
            kinds,
            public_shares: snapshot.public_shares,
            shuffled: snapshot.shuffled,
            deck: snapshot.deck,
            pointer: snapshot.pointer,
            dealt: snapshot.dealt,
            shares: snapshot.shares,
            public: snapshot.public,
        })
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            public_shares: self.public_shares,
            shuffled: self.shuffled,
            deck: self.deck.clone(),
            pointer: self.pointer,
            dealt: self.dealt.clone(),
            shares: self.shares.clone(),
            public: self.public.clone(),
        }
    }

    fn restore_from(&mut self, snapshot: &Snapshot) -> Result<(), DealError> {
        self.public_shares = snapshot.public_shares;
        self.shuffled = snapshot.shuffled;
        self.deck.clone_from(&snapshot.deck);
        self.pointer = snapshot.pointer;
        self.dealt.clone_from(&snapshot.dealt);
        self.shares.clone_from(&snapshot.shares);
        self.public.clone_from(&snapshot.public);
        Ok(())
    }
}

/// Assembles the deal payload for one entry.
///
/// Mirrors [`DealState::apply`] exactly: the same parts in the same order
/// against the same transcript. The author does not advance their own state
/// here — they apply the finished payload like anybody else, so both sides run
/// identical code and a mistake shows up on the device that made it.
pub struct PayloadBuilder<'a> {
    state: &'a DealState,
    transcript: Transcript,
    parts: Vec<u8>,
    count: u8,
    pointer: u32,
    deck: Option<Vec<Ciphertext>>,
    /// Our own key share, when this payload is the one publishing it.
    ///
    /// One entry may carry a key share and a shuffle together, and the shuffle
    /// needs the joint key the share it is travelling with completes.
    pending_key: Option<PublicShare>,
}

impl PayloadBuilder<'_> {
    /// Publishes this player's key share.
    pub fn key(mut self, entropy: &[u8]) -> Self {
        let share = self.state.key.public();
        let proof = self
            .state
            .key
            .prove_knowledge(&mut self.transcript, entropy);

        self.parts.push(PART_KEY);
        self.parts.extend_from_slice(&share.to_bytes());
        self.parts.extend_from_slice(&proof.to_bytes());
        self.count += 1;
        self.pending_key = Some(share);
        self
    }

    /// Shuffles the deck and proves it.
    pub fn shuffle(mut self, entropy: &[u8]) -> Self {
        let key = self
            .joint_key()
            .expect("both key shares are published before anybody shuffles");
        let input = self.deck.clone().unwrap_or_else(|| self.state.deck.clone());

        let shuffled = shuffle::shuffle(&mut self.transcript, &input, &key, entropy);

        self.parts.push(PART_SHUFFLE);
        for ciphertext in &shuffled.deck {
            self.parts.extend_from_slice(&ciphertext.to_bytes());
        }
        self.parts.extend_from_slice(&shuffled.proof.to_bytes());
        self.count += 1;
        self.deck = Some(shuffled.deck);
        self
    }

    /// Hands the opponent the next `count` positions off the top of the deck.
    pub fn deal(mut self, count: u16, entropy: &[u8]) -> Self {
        let positions: Vec<u16> = (0..count)
            .map(|i| (self.pointer + u32::from(i)) as u16)
            .collect();
        self.pointer += u32::from(count);
        self.shares(PART_DEAL, &positions, entropy);
        self
    }

    /// Opens positions this player holds, so everyone can read them.
    pub fn reveal(mut self, positions: &[u16], entropy: &[u8]) -> Self {
        self.shares(PART_REVEAL, positions, entropy);
        self
    }

    /// The joint key, counting a share this payload is about to publish.
    fn joint_key(&self) -> Option<RistrettoPoint> {
        let mut shares = self.state.public_shares;
        if let Some(pending) = self.pending_key {
            shares[self.state.me as usize] = Some(pending);
        }
        match (shares[0], shares[1]) {
            (Some(a), Some(b)) => Some(PublicShare::joint(&a, &b)),
            _ => None,
        }
    }

    fn shares(&mut self, kind: u8, positions: &[u16], entropy: &[u8]) {
        let deck = self.deck.as_ref().unwrap_or(&self.state.deck);

        self.parts.push(kind);
        self.parts
            .extend_from_slice(&(positions.len() as u16).to_le_bytes());

        for (index, &position) in positions.iter().enumerate() {
            let ciphertext = deck[position as usize];

            self.transcript
                .absorb_u32(b"deal-position", u32::from(position));
            self.transcript.absorb_u32(b"deal-index", index as u32);
            let (share, proof) = self.state.key.proven_share(
                &mut self.transcript,
                &ciphertext,
                entropy,
                u32::from(position),
            );

            self.parts.extend_from_slice(&position.to_le_bytes());
            put_point(&mut self.parts, &share);
            self.parts.extend_from_slice(&proof.to_bytes());
        }

        self.count += 1;
    }

    /// The finished payload, ready to go into a move.
    pub fn finish(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.parts.len() + 1);
        out.push(self.count);
        out.extend_from_slice(&self.parts);
        out
    }
}

/// The part of a deal that can be written down.
#[derive(Clone)]
struct Snapshot {
    public_shares: [Option<PublicShare>; 2],
    shuffled: [bool; 2],
    deck: Vec<Ciphertext>,
    pointer: u32,
    dealt: BTreeMap<u16, u8>,
    shares: BTreeMap<(u16, u8), RistrettoPoint>,
    public: BTreeMap<u16, u8>,
}

impl Snapshot {
    fn ready(&self) -> bool {
        self.public_shares.iter().all(Option::is_some) && self.shuffled.iter().all(|&done| done)
    }

    fn joint_key(&self) -> Option<RistrettoPoint> {
        match (self.public_shares[0], self.public_shares[1]) {
            (Some(a), Some(b)) => Some(PublicShare::joint(&a, &b)),
            _ => None,
        }
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = vec![SNAPSHOT_VERSION];

        let mut flags = 0u8;
        for (i, share) in self.public_shares.iter().enumerate() {
            if share.is_some() {
                flags |= 1 << i;
            }
            if self.shuffled[i] {
                flags |= 1 << (i + 2);
            }
        }
        out.push(flags);
        for share in self.public_shares.iter().flatten() {
            out.extend_from_slice(&share.to_bytes());
        }

        out.extend_from_slice(&(self.deck.len() as u32).to_le_bytes());
        for ciphertext in &self.deck {
            out.extend_from_slice(&ciphertext.to_bytes());
        }
        out.extend_from_slice(&self.pointer.to_le_bytes());

        out.extend_from_slice(&(self.dealt.len() as u32).to_le_bytes());
        for (&position, &who) in &self.dealt {
            out.extend_from_slice(&position.to_le_bytes());
            out.push(who);
        }

        out.extend_from_slice(&(self.shares.len() as u32).to_le_bytes());
        for (&(position, who), share) in &self.shares {
            out.extend_from_slice(&position.to_le_bytes());
            out.push(who);
            put_point(&mut out, share);
        }

        out.extend_from_slice(&(self.public.len() as u32).to_le_bytes());
        for (&position, &tile) in &self.public {
            out.extend_from_slice(&position.to_le_bytes());
            out.push(tile);
        }

        out
    }

    fn decode(bytes: &[u8]) -> Result<Self, DealError> {
        let (version, rest) = take_u8(bytes)?;
        if version != SNAPSHOT_VERSION {
            return Err(DealError::BadEncoding);
        }

        let (flags, mut rest) = take_u8(rest)?;
        let mut public_shares = [None, None];
        for (i, slot) in public_shares.iter_mut().enumerate() {
            if flags & (1 << i) != 0 {
                *slot = Some(PublicShare::from_bytes(rest)?);
                rest = &rest[POINT_LEN..];
            }
        }
        let shuffled = [flags & 0b100 != 0, flags & 0b1000 != 0];

        let (deck_len, mut rest) = take_u32(rest)?;
        let mut deck = Vec::with_capacity(deck_len as usize);
        for _ in 0..deck_len {
            deck.push(Ciphertext::from_bytes(rest)?);
            rest = &rest[crate::CIPHERTEXT_LEN..];
        }

        let (pointer, mut rest) = take_u32(rest)?;

        let (dealt_len, tail) = take_u32(rest)?;
        rest = tail;
        let mut dealt = BTreeMap::new();
        for _ in 0..dealt_len {
            let (position, tail) = take_u16(rest)?;
            let (who, tail) = take_u8(tail)?;
            dealt.insert(position, who);
            rest = tail;
        }

        let (shares_len, tail) = take_u32(rest)?;
        rest = tail;
        let mut shares = BTreeMap::new();
        for _ in 0..shares_len {
            let (position, tail) = take_u16(rest)?;
            let (who, tail) = take_u8(tail)?;
            shares.insert((position, who), point_from_bytes(tail)?);
            rest = &tail[POINT_LEN..];
        }

        let (public_len, tail) = take_u32(rest)?;
        rest = tail;
        let mut public = BTreeMap::new();
        for _ in 0..public_len {
            let (position, tail) = take_u16(rest)?;
            let (tile, tail) = take_u8(tail)?;
            public.insert(position, tile);
            rest = tail;
        }

        Ok(Self {
            public_shares,
            shuffled,
            deck,
            pointer,
            dealt,
            shares,
            public,
        })
    }
}

// -- reading ------------------------------------------------------------------

fn take_u8(bytes: &[u8]) -> Result<(u8, &[u8]), DealError> {
    match bytes.split_first() {
        Some((&value, rest)) => Ok((value, rest)),
        None => Err(DealError::Truncated),
    }
}

fn take_u16(bytes: &[u8]) -> Result<(u16, &[u8]), DealError> {
    if bytes.len() < 2 {
        return Err(DealError::Truncated);
    }
    Ok((u16::from_le_bytes([bytes[0], bytes[1]]), &bytes[2..]))
}

fn take_u32(bytes: &[u8]) -> Result<(u32, &[u8]), DealError> {
    if bytes.len() < 4 {
        return Err(DealError::Truncated);
    }
    let value = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    Ok((value, &bytes[4..]))
}

/// One decryption share as it appears in a payload.
struct Published {
    position: u16,
    share: RistrettoPoint,
    proof: EqualityProof,
}

fn take_share(bytes: &[u8]) -> Result<(Published, &[u8]), DealError> {
    let (position, rest) = take_u16(bytes)?;
    if rest.len() < POINT_LEN + EQUALITY_PROOF_LEN {
        return Err(DealError::Truncated);
    }
    Ok((
        Published {
            position,
            share: point_from_bytes(rest)?,
            proof: EqualityProof::from_bytes(&rest[POINT_LEN..])?,
        },
        &rest[POINT_LEN + EQUALITY_PROOF_LEN..],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GAME: [u8; 16] = [0x4b; 16];
    const KINDS: u8 = 27;
    /// Small enough to keep the tests quick, large enough to deal from.
    const BAG: [u8; 12] = [1, 2, 3, 4, 5, 0, 6, 7, 8, 9, 0, 10];

    const INITIATOR: u8 = 0;
    const CLAIMER: u8 = 1;

    fn key(index: u8) -> KeyShare {
        KeyShare::from_wide_bytes(&[0x10 + index; 64])
    }

    /// Both devices, each with its own view of the same deal.
    struct Table {
        initiator: DealState,
        claimer: DealState,
    }

    impl Table {
        fn new() -> Self {
            Self {
                initiator: DealState::new(GAME, INITIATOR, key(0), &BAG, KINDS),
                claimer: DealState::new(GAME, CLAIMER, key(1), &BAG, KINDS),
            }
        }

        fn of(&mut self, who: u8) -> &mut DealState {
            if who == INITIATOR {
                &mut self.initiator
            } else {
                &mut self.claimer
            }
        }

        /// Applies one payload to both devices, as the log would.
        fn submit(&mut self, author: u8, seq: u32, payload: &[u8]) -> Result<Facts, DealError> {
            let theirs = self.of(1 - author).apply(author, seq, payload);
            let mine = self.of(author).apply(author, seq, payload);

            // Both devices must reach the same verdict, or the game has forked.
            assert_eq!(theirs.is_ok(), mine.is_ok(), "the two devices disagreed");
            mine
        }

        /// Runs the opening ceremony: keys, shuffles, and the first racks.
        fn open(&mut self, rack: u16) -> Result<(), DealError> {
            let payload = self.initiator.build(2).key(&[0x01; 32]).finish();
            self.submit(INITIATOR, 2, &payload)?;

            let payload = self
                .claimer
                .build(3)
                .key(&[0x02; 32])
                .shuffle(&[0x03; 32])
                .finish();
            self.submit(CLAIMER, 3, &payload)?;

            let payload = self
                .initiator
                .build(4)
                .shuffle(&[0x04; 32])
                .deal(rack, &[0x05; 32])
                .finish();
            self.submit(INITIATOR, 4, &payload)?;

            let payload = self.claimer.build(5).deal(rack, &[0x06; 32]).finish();
            self.submit(CLAIMER, 5, &payload)?;

            Ok(())
        }
    }

    #[test]
    fn a_ceremony_leaves_both_players_holding_tiles_only_they_can_read() {
        let mut table = Table::new();
        table.open(3).expect("an honest ceremony is accepted");

        assert!(table.initiator.ready());
        assert!(table.claimer.ready());

        // The claimer was dealt positions 0..3, the initiator 3..6.
        assert_eq!(table.claimer.held(), vec![0, 1, 2]);
        assert_eq!(table.initiator.held(), vec![3, 4, 5]);

        // Each can read their own and none of the opponent's.
        for position in 0..3 {
            assert!(table.claimer.tile(position).is_some());
            assert!(table.initiator.tile(position).is_none());
        }
        for position in 3..6 {
            assert!(table.initiator.tile(position).is_some());
            assert!(table.claimer.tile(position).is_none());
        }
    }

    #[test]
    fn the_tiles_dealt_are_tiles_that_were_in_the_bag() {
        let mut table = Table::new();
        table.open(6).expect("an honest ceremony is accepted");

        let mut dealt: Vec<u8> = table
            .claimer
            .held()
            .iter()
            .filter_map(|&p| table.claimer.tile(p))
            .chain(
                table
                    .initiator
                    .held()
                    .iter()
                    .filter_map(|&p| table.initiator.tile(p)),
            )
            .collect();
        dealt.sort_unstable();

        let mut bag = BAG.to_vec();
        bag.sort_unstable();

        assert_eq!(dealt.len(), 12);
        assert_eq!(dealt, bag);
    }

    #[test]
    fn revealing_a_tile_makes_it_readable_by_everyone() {
        let mut table = Table::new();
        table.open(3).expect("an honest ceremony is accepted");

        let held = table.claimer.held()[0];
        let expected = table.claimer.tile(held).expect("the claimer can read it");

        let payload = table.claimer.build(6).reveal(&[held], &[0x07; 32]).finish();
        let facts = table.submit(CLAIMER, 6, &payload).expect("a legal reveal");

        assert_eq!(facts.public, vec![(held, expected)]);
        assert_eq!(table.initiator.tile(held), Some(expected));
        assert_eq!(table.claimer.tile(held), Some(expected));
    }

    #[test]
    fn a_player_cannot_reveal_a_tile_they_do_not_hold() {
        // Opening the opponent's rack would be the whole game.
        let mut table = Table::new();
        table.open(3).expect("an honest ceremony is accepted");

        let theirs = table.initiator.held()[0];
        let payload = table
            .claimer
            .build(6)
            .reveal(&[theirs], &[0x07; 32])
            .finish();

        assert_eq!(
            table.initiator.apply(CLAIMER, 6, &payload),
            Err(DealError::OutOfRange)
        );
    }

    #[test]
    fn a_player_cannot_deal_out_of_order() {
        // Choosing which position to deal is choosing which tile to hand over,
        // for anyone who has learned something about the deck.
        let mut table = Table::new();
        table.open(2).expect("an honest ceremony is accepted");

        let mut payload = table.claimer.build(6).deal(1, &[0x07; 32]).finish();
        // Rewrite the position in the payload: kind, count, then position.
        let at = payload.len() - (POINT_LEN + EQUALITY_PROOF_LEN + 2);
        payload[at..at + 2].copy_from_slice(&9u16.to_le_bytes());

        assert_eq!(
            table.initiator.apply(CLAIMER, 6, &payload),
            Err(DealError::OutOfRange)
        );
    }

    #[test]
    fn dealing_past_the_end_of_the_bag_is_refused() {
        // An honest client never builds this, so the payload is assembled by
        // hand: a legal share entry with the position rewritten to one past the
        // last tile, offered when the bag is empty.
        let mut table = Table::new();
        table.open(6).expect("an honest ceremony is accepted");
        assert_eq!(table.claimer.remaining(), 0);

        let held = table.claimer.held()[0];
        let mut payload = table.claimer.build(6).reveal(&[held], &[0x07; 32]).finish();
        payload[1] = PART_DEAL;
        payload[4..6].copy_from_slice(&(BAG.len() as u16).to_le_bytes());

        assert_eq!(
            table.initiator.apply(CLAIMER, 6, &payload),
            Err(DealError::OutOfRange)
        );
    }

    #[test]
    fn nobody_may_publish_two_key_shares() {
        // A second share after seeing the opponent's would let a player choose
        // the joint key.
        let mut table = Table::new();
        let payload = table.initiator.build(2).key(&[0x01; 32]).finish();
        table.submit(INITIATOR, 2, &payload).expect("the first one");

        let again = table.initiator.build(3).key(&[0x09; 32]).finish();
        assert_eq!(
            table.claimer.apply(INITIATOR, 3, &again),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn nobody_may_shuffle_twice() {
        let mut table = Table::new();
        table.open(3).expect("an honest ceremony is accepted");

        let payload = table.claimer.build(6).shuffle(&[0x09; 32]).finish();
        assert_eq!(
            table.initiator.apply(CLAIMER, 6, &payload),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn shuffling_before_both_keys_are_known_is_refused() {
        // There would be no joint key to re-randomise under. The payload is
        // built on a table that does have both keys, then offered to one that
        // has only heard from the initiator.
        let mut complete = Table::new();
        let payload = complete.initiator.build(2).key(&[0x01; 32]).finish();
        complete.submit(INITIATOR, 2, &payload).expect("the key");
        let payload = complete.claimer.build(3).key(&[0x02; 32]).finish();
        complete
            .submit(CLAIMER, 3, &payload)
            .expect("the other key");
        let shuffle = complete.initiator.build(4).shuffle(&[0x04; 32]).finish();

        let mut half = Table::new();
        let payload = half.initiator.build(2).key(&[0x01; 32]).finish();
        half.submit(INITIATOR, 2, &payload).expect("the key");

        assert_eq!(
            half.claimer.apply(INITIATOR, 4, &shuffle),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn dealing_before_the_ceremony_finishes_is_refused() {
        let mut table = Table::new();
        let payload = table.initiator.build(2).key(&[0x01; 32]).finish();
        table.submit(INITIATOR, 2, &payload).expect("the key");
        let payload = table
            .claimer
            .build(3)
            .key(&[0x02; 32])
            .shuffle(&[0x03; 32])
            .finish();
        table.submit(CLAIMER, 3, &payload).expect("key and shuffle");

        // The initiator has not shuffled yet, so the deck is not final.
        let early = table.initiator.build(4).deal(1, &[0x05; 32]).finish();
        assert_eq!(
            table.claimer.apply(INITIATOR, 4, &early),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_payload_is_applied_whole_or_not_at_all() {
        // A shuffle followed by a bad deal must not leave the deck shuffled:
        // half-applied state is how two devices stop agreeing.
        let mut table = Table::new();
        let payload = table.initiator.build(2).key(&[0x01; 32]).finish();
        table.submit(INITIATOR, 2, &payload).expect("the key");
        let payload = table
            .claimer
            .build(3)
            .key(&[0x02; 32])
            .shuffle(&[0x03; 32])
            .finish();
        table.submit(CLAIMER, 3, &payload).expect("key and shuffle");

        let mut mixed = table
            .initiator
            .build(4)
            .shuffle(&[0x04; 32])
            .deal(2, &[0x05; 32])
            .finish();
        // Corrupt the last share's proof, well past the shuffle.
        let last = mixed.len() - 1;
        mixed[last] ^= 0x01;

        let before = table.claimer.save();
        assert!(table.claimer.apply(INITIATOR, 4, &mixed).is_err());
        assert_eq!(table.claimer.save(), before);
    }

    #[test]
    fn a_payload_meant_for_another_entry_is_refused() {
        // The transcript binds every proof to its sequence number, so replaying
        // a legitimate payload one entry later fails.
        let mut table = Table::new();
        let payload = table.initiator.build(2).key(&[0x01; 32]).finish();

        assert!(table.claimer.apply(INITIATOR, 3, &payload).is_err());
    }

    #[test]
    fn a_deal_signed_by_the_wrong_player_is_refused() {
        let mut table = Table::new();
        table.open(2).expect("an honest ceremony is accepted");

        let payload = table.claimer.build(6).deal(1, &[0x07; 32]).finish();

        // The same bytes, attributed to the initiator: the shares inside were
        // computed with the claimer's key and will not match.
        assert_eq!(
            table.claimer.apply(INITIATOR, 6, &payload),
            Err(DealError::BadProof)
        );
    }

    #[test]
    fn a_state_survives_being_saved_and_restored() {
        let mut table = Table::new();
        table.open(3).expect("an honest ceremony is accepted");

        let saved = table.claimer.save();
        let restored = DealState::load(GAME, CLAIMER, key(1), KINDS, &saved)
            .expect("what we just saved loads");

        assert_eq!(restored.held(), table.claimer.held());
        assert_eq!(restored.pointer(), table.claimer.pointer());
        assert!(restored.ready());
        for position in restored.held() {
            assert_eq!(restored.tile(position), table.claimer.tile(position));
        }
    }

    #[test]
    fn a_restored_state_carries_on_where_it_left_off() {
        // The point of saving: a device that reopens a game must not have to
        // verify every proof in the log again.
        let mut table = Table::new();
        table.open(3).expect("an honest ceremony is accepted");

        let saved = table.claimer.save();
        let mut restored = DealState::load(GAME, CLAIMER, key(1), KINDS, &saved).expect("loads");

        let payload = table.initiator.build(6).deal(1, &[0x08; 32]).finish();
        let facts = restored
            .apply(INITIATOR, 6, &payload)
            .expect("the next entry applies to a restored state");

        assert_eq!(facts.mine.len(), 1);
        assert_eq!(restored.held().len(), 4);
    }

    #[test]
    fn a_damaged_snapshot_is_refused_rather_than_misread() {
        let mut table = Table::new();
        table.open(3).expect("an honest ceremony is accepted");
        let saved = table.claimer.save();

        assert!(DealState::load(GAME, CLAIMER, key(1), KINDS, &saved[..saved.len() - 1]).is_err());
        assert!(DealState::load(GAME, CLAIMER, key(1), KINDS, &[]).is_err());
        assert!(DealState::load(GAME, CLAIMER, key(1), KINDS, &[9]).is_err());
    }

    #[test]
    fn the_ceremony_tells_each_player_what_it_wants_next() {
        let mut table = Table::new();
        assert_eq!(table.initiator.step(), Step::Key);

        let payload = table.initiator.build(2).key(&[0x01; 32]).finish();
        table.submit(INITIATOR, 2, &payload).expect("the key");
        // Still waiting on the claimer's key before anyone can shuffle.
        assert_eq!(table.initiator.step(), Step::Play);
        assert_eq!(table.claimer.step(), Step::Key);

        let payload = table.claimer.build(3).key(&[0x02; 32]).finish();
        table.submit(CLAIMER, 3, &payload).expect("the other key");
        assert_eq!(table.initiator.step(), Step::Shuffle);
        assert_eq!(table.claimer.step(), Step::Shuffle);
    }

    #[test]
    fn the_ceremony_is_reported_complete_exactly_once() {
        let mut table = Table::new();

        let payload = table.initiator.build(2).key(&[0x01; 32]).finish();
        assert!(!table.submit(INITIATOR, 2, &payload).unwrap().ready);

        let payload = table
            .claimer
            .build(3)
            .key(&[0x02; 32])
            .shuffle(&[0x03; 32])
            .finish();
        assert!(!table.submit(CLAIMER, 3, &payload).unwrap().ready);

        let payload = table.initiator.build(4).shuffle(&[0x04; 32]).finish();
        assert!(table.submit(INITIATOR, 4, &payload).unwrap().ready);

        let payload = table.initiator.build(5).deal(1, &[0x05; 32]).finish();
        assert!(!table.submit(INITIATOR, 5, &payload).unwrap().ready);
    }
}
