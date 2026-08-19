//! Turning a sorted word list into the byte form the reader consumes.
//!
//! This is Daciuk, Mihov, Watson and Watson's incremental construction: feed
//! words in lexicographic order and the graph is minimised as it goes, so the
//! whole list never has to exist as an un-minimised trie in memory. Each time a
//! word diverges from its predecessor, the suffix that just became final is
//! looked up in a register of nodes already seen and replaced by the canonical
//! one if an identical node exists.
//!
//! Output is **byte-identical for identical input**. That is a requirement, not
//! a nicety: the committed dictionary is checked against a pinned hash, so a
//! build that shuffled equivalent nodes around would fail its own golden test
//! and, worse, would hand two players files they could not agree on.

use std::collections::HashMap;

use crate::{FORMAT_VERSION, HEADER_LEN, MAGIC, MAX_UNITS, letter_index, pack_unit};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildError {
    /// A word contained something other than `a`..=`z`.
    NotLowercase,
    /// Words did not arrive in lexicographic order.
    OutOfOrder,
    /// The same word twice.
    Duplicate,
    /// The graph outgrew the 25-bit child index.
    TooLarge,
}

impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotLowercase => f.write_str("words must be lowercase a-z"),
            Self::OutOfOrder => f.write_str("words must be sorted"),
            Self::Duplicate => f.write_str("duplicate word"),
            Self::TooLarge => f.write_str("word list is too large for this format"),
        }
    }
}

impl std::error::Error for BuildError {}

type NodeId = usize;

#[derive(Default, Clone, PartialEq, Eq, Hash)]
struct Node {
    terminal: bool,
    /// `(letter, child)`, kept in alphabetical order because words arrive that
    /// way. The reader relies on that order to stop scanning early.
    edges: Vec<(u8, NodeId)>,
}

pub struct Builder {
    nodes: Vec<Node>,
    /// Nodes already known to be final, keyed by their whole shape. Two nodes
    /// with the same shape accept the same suffixes and can be the same node.
    register: HashMap<Node, NodeId>,
    /// The path of nodes not yet known to be final: the tail of the last word.
    unchecked: Vec<(NodeId, u8, NodeId)>,
    previous: Vec<u8>,
    words: u32,
}

impl Default for Builder {
    fn default() -> Self {
        Self::new()
    }
}

impl Builder {
    pub fn new() -> Self {
        Self {
            // Node 0 is the root.
            nodes: vec![Node::default()],
            register: HashMap::new(),
            unchecked: Vec::new(),
            previous: Vec::new(),
            words: 0,
        }
    }

    /// Adds one word. Words must arrive sorted and without repeats.
    pub fn insert(&mut self, word: &[u8]) -> Result<(), BuildError> {
        if word.is_empty() || word.iter().any(|&b| letter_index(b).is_none()) {
            return Err(BuildError::NotLowercase);
        }
        match word.cmp(&self.previous[..]) {
            std::cmp::Ordering::Less => return Err(BuildError::OutOfOrder),
            std::cmp::Ordering::Equal if self.words > 0 => return Err(BuildError::Duplicate),
            _ => {}
        }

        let common = word
            .iter()
            .zip(&self.previous)
            .take_while(|(a, b)| a == b)
            .count();

        self.minimize(common);

        let mut node = match self.unchecked.last() {
            Some(&(_, _, child)) => child,
            None => 0,
        };

        for &byte in &word[common..] {
            let next = self.new_node();
            self.nodes[node].edges.push((byte - b'a', next));
            self.unchecked.push((node, byte - b'a', next));
            node = next;
        }

        self.nodes[node].terminal = true;
        self.previous = word.to_vec();
        self.words += 1;
        Ok(())
    }

    /// Folds every unchecked node deeper than `depth` into the register.
    ///
    /// Working from the deepest end matters: a node can only be compared for
    /// equality once all of its own children are final, and the deepest node in
    /// the path is the one nothing can be appended to any more.
    fn minimize(&mut self, depth: usize) {
        while self.unchecked.len() > depth {
            let (parent, letter, child) = self.unchecked.pop().expect("loop guard checked length");
            let shape = self.nodes[child].clone();

            match self.register.get(&shape) {
                Some(&canonical) => {
                    // An identical node already exists; point at it instead and
                    // abandon this one. Abandoned nodes are simply never
                    // reachable from the root, so serialization skips them.
                    let edge = self.nodes[parent]
                        .edges
                        .iter_mut()
                        .find(|(l, _)| *l == letter)
                        .expect("the edge was pushed when the node was created");
                    edge.1 = canonical;
                }
                None => {
                    self.register.insert(shape, child);
                }
            }
        }
    }

    fn new_node(&mut self) -> NodeId {
        self.nodes.push(Node::default());
        self.nodes.len() - 1
    }

    /// Finishes minimisation and writes the file.
    pub fn finish(mut self) -> Result<Vec<u8>, BuildError> {
        self.minimize(0);

        // Reachable nodes, in the order a depth-first walk meets them. Nothing
        // here iterates a hash map, so the layout depends only on the words.
        let mut order: Vec<NodeId> = Vec::new();
        let mut position: HashMap<NodeId, u32> = HashMap::new();
        let mut stack = vec![0usize];
        let mut seen = vec![false; self.nodes.len()];
        seen[0] = true;

        while let Some(node) = stack.pop() {
            order.push(node);
            // Reversed, so the walk descends into the alphabetically first edge
            // first and the layout is stable.
            for &(_, child) in self.nodes[node].edges.iter().rev() {
                if !seen[child] {
                    seen[child] = true;
                    stack.push(child);
                }
            }
        }

        // Index 0 is a sentinel, so that a child index of 0 can mean "none".
        let mut next: u32 = 1;
        for &node in &order {
            let edges = self.nodes[node].edges.len() as u32;
            // A node with no edges occupies nothing and is addressed as 0.
            position.insert(node, if edges == 0 { 0 } else { next });
            next = next.checked_add(edges).ok_or(BuildError::TooLarge)?;
        }

        if next > MAX_UNITS {
            return Err(BuildError::TooLarge);
        }

        let mut units: Vec<u32> = vec![0; next as usize];
        for &node in &order {
            let start = position[&node];
            if start == 0 {
                continue;
            }
            let edges = &self.nodes[node].edges;
            for (i, &(letter, child)) in edges.iter().enumerate() {
                units[start as usize + i] = pack_unit(
                    letter,
                    self.nodes[child].terminal,
                    i + 1 == edges.len(),
                    position[&child],
                );
            }
        }

        let root = position[&0];
        let mut out = Vec::with_capacity(HEADER_LEN + units.len() * 4);
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&(units.len() as u32).to_le_bytes());
        out.extend_from_slice(&root.to_le_bytes());
        out.extend_from_slice(&self.words.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // reserved
        for unit in &units {
            out.extend_from_slice(&unit.to_le_bytes());
        }

        Ok(out)
    }
}

/// Compiles a whole list at once, sorting and de-duplicating it first.
pub fn compile(words: &[&str]) -> Result<Vec<u8>, BuildError> {
    let mut sorted: Vec<&[u8]> = words.iter().map(|w| w.as_bytes()).collect();
    sorted.sort_unstable();
    sorted.dedup();

    let mut builder = Builder::new();
    for word in sorted {
        builder.insert(word)?;
    }
    builder.finish()
}
