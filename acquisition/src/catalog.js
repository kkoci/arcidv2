"use strict";
/**
 * catalog.js — demo track catalog for the AcquisitionAgent.
 *
 * ArtistRegistry.sol only stores a fingerprintHash + rightsMetadataHash
 * (a commitment, not descriptive content — see Phase 1's own design and
 * CHANGELOG.md's "real vs simulated" note). Nothing on-chain gives an LLM
 * anything to reason about, so this off-chain catalog supplies the actual
 * descriptive metadata (genre/era/mood/vocals/explicit) the agent judges
 * against a brief. rightsMetadataHash committed on-chain is a hash of this
 * same metadata — the commitment is real, the descriptive content behind
 * it is demo-scale, same honesty split as fingerprinting/corpus-scale
 * elsewhere in this vertical.
 *
 * Deliberately built with genuine ambiguity, not just obviously-matching
 * keywords: several tracks share individual tags with a given brief
 * without actually fitting it (e.g. "energetic" alone isn't "late-90s
 * alt-rock"), so a real fit judgment is required — a keyword filter would
 * either over- or under-select relative to what a listener would actually
 * call a fit.
 */

const TRACKS = [
  {
    id: "neon-skyline",
    artistKey: "A",
    title: "Neon Skyline",
    genre: "alt-rock",
    era: "late-90s",
    mood: "energetic",
    vocals: "female",
    explicit: false,
  },
  {
    id: "quiet-static",
    artistKey: "A",
    title: "Quiet Static",
    genre: "ambient",
    era: "2010s",
    mood: "melancholic",
    vocals: "instrumental",
    explicit: false,
  },
  {
    id: "concrete-bloom",
    artistKey: "B",
    title: "Concrete Bloom",
    genre: "alt-rock",
    era: "late-90s",
    mood: "energetic",
    vocals: "female",
    explicit: false,
  },
  {
    id: "bassline-riot",
    artistKey: "B",
    title: "Bassline Riot",
    genre: "hip-hop",
    era: "2000s",
    mood: "aggressive",
    vocals: "male",
    explicit: true,
  },
  {
    id: "golden-hour-drive",
    artistKey: "C",
    title: "Golden Hour Drive",
    genre: "synthwave",
    era: "80s-revival",
    mood: "uplifting",
    vocals: "instrumental",
    explicit: false,
  },
  {
    id: "static-prayer",
    artistKey: "C",
    title: "Static Prayer",
    genre: "alt-rock",
    era: "late-90s",
    mood: "energetic",
    vocals: "female",
    explicit: false,
  },
];

module.exports = { TRACKS };
