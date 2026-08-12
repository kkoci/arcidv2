"use strict";
/**
 * agent.js — AcquisitionAgent: the real judgment layer for Training
 * Compensation. Given a creative brief, a budget, and a catalog of
 * candidate tracks, judges each track's fit to the brief via a real
 * Claude call (same tool_use pattern as consumer/src/adjudicator.js, the
 * original Price-Oracle vertical's LLM-judge step) and selects a subset
 * within budget.
 *
 * Scope boundary, deliberate: this module ONLY decides WHAT to buy. It
 * has no knowledge of TrainingPool, CompensationClaim, or the ingestion
 * enclave — those stay exactly as deterministic as Phases 1-7 built them.
 * The CLI script that calls this (scripts/cli/demo-acquisition.js) is the
 * only place the agent's output (a track list) crosses into the existing
 * settlement machinery, and it crosses as plain data (a corpus root), not
 * as an actor with any settlement authority.
 */

const Anthropic = require("@anthropic-ai/sdk");
const config    = require("./config");

const client = new Anthropic.default({ apiKey: config.ANTHROPIC_API_KEY });

const FIT_TOOL = {
  name: "evaluate_fit",
  description:
    "Judge whether a single candidate track plausibly fits a creative brief. Called once per " +
    "candidate track — a real creative judgment call, not a keyword match.",
  input_schema: {
    type: "object",
    properties: {
      fits: {
        type: "boolean",
        description:
          "true if this track plausibly fits the brief's overall intent, false otherwise. Judge " +
          "the combination of genre/era/mood/vocals/explicit content together, not a checklist of " +
          "individually-matching tags — a track can share one tag with the brief and still be a " +
          "poor fit overall, or fit the spirit of the brief without matching every word.",
      },
      reason: {
        type: "string",
        description:
          "One or two sentences of written rationale grounded in this track's actual metadata " +
          "against the brief's actual criteria. Plain prose, no markdown — never a generic " +
          "restatement of the brief.",
      },
    },
    required: ["fits", "reason"],
  },
};

const SYSTEM_PROMPT = `You are a music-licensing acquisition agent for an AI training-data pipeline. You are given a creative brief and one candidate track's metadata at a time. Judge whether this specific track plausibly fits the brief — a genuine creative judgment call, not exact keyword matching.

A track can share an individual tag with the brief (mood, era, or genre alone) and still be a poor overall fit if the combination doesn't match the brief's actual intent. A track can also fit the spirit of a brief without using the brief's exact words. Weigh genre, era, mood, vocals, and explicit-content restrictions together, the way a human music supervisor would — not as an independent checklist where matching any one field is enough.

Be willing to reject tracks that only partially match, and be willing to accept tracks that fit well even if described differently from the brief's wording. Always call evaluate_fit exactly once with your judgment and a short, specific written rationale.`;

/**
 * The real Claude call — one candidate track per call, same tool_choice-
 * forced structured-output pattern consumer/src/adjudicator.js uses.
 * @param {string} brief
 * @param {object} track {title, genre, era, mood, vocals, explicit, ...}
 * @returns {Promise<{fits: boolean, reason: string}>}
 */
async function evaluateFit(brief, track) {
  const userMessage = `Brief: "${brief}"

Candidate track:
- title: ${track.title}
- genre: ${track.genre}
- era: ${track.era}
- mood: ${track.mood}
- vocals: ${track.vocals}
- explicit: ${track.explicit}

Does this track plausibly fit the brief?`;

  const msg = await client.messages.create({
    model: config.MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    tools: [FIT_TOOL],
    tool_choice: { type: "tool", name: "evaluate_fit" },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("AcquisitionAgent did not call evaluate_fit tool");
  return { fits: !!toolUse.input.fits, reason: String(toolUse.input.reason || "") };
}

/**
 * Evaluates every candidate against the brief, then selects the fitting
 * tracks in catalog order up to budget. Non-deterministic by design where
 * it matters (the fit judgment) — deterministic and auditable where it
 * doesn't (the budget cutoff: catalog order, no hidden ranking).
 *
 * @param {object} params
 * @param {string} params.brief
 * @param {number} params.budget whole-USDC budget, e.g. 3.0
 * @param {number} [params.pricePerTrack] flat whole-USDC license price per track (default 1.0)
 * @param {object[]} params.catalog candidate tracks — each needs at least {id, title, ...metadata}
 * @param {(brief:string, track:object) => Promise<{fits:boolean, reason:string}>} [params.evaluateFn]
 *        injectable for testing — defaults to the real Claude call above
 * @returns {Promise<{
 *   evaluations: {track:object, fits:boolean, reason:string}[],
 *   selected: object[],
 *   totalCost: number,
 *   budget: number,
 *   pricePerTrack: number,
 * }>}
 */
async function selectTracks({ brief, budget, pricePerTrack = 1.0, catalog, evaluateFn = evaluateFit }) {
  if (!brief) throw new Error("selectTracks: brief is required");
  if (!(budget > 0)) throw new Error("selectTracks: budget must be > 0");
  if (!Array.isArray(catalog) || catalog.length === 0) throw new Error("selectTracks: catalog must be non-empty");

  const evaluations = [];
  for (const track of catalog) {
    const { fits, reason } = await evaluateFn(brief, track);
    evaluations.push({ track, fits: !!fits, reason });
  }

  const maxAffordable = Math.floor(budget / pricePerTrack);
  const fitting = evaluations.filter((e) => e.fits).map((e) => e.track);
  // Budget-truncated in catalog/evaluation order — a plain, auditable
  // cutoff rule, not a hidden secondary ranking call.
  const selected = fitting.slice(0, maxAffordable);

  return {
    evaluations,
    selected,
    totalCost: Math.round(selected.length * pricePerTrack * 100) / 100,
    budget,
    pricePerTrack,
  };
}

module.exports = { evaluateFit, selectTracks, FIT_TOOL, SYSTEM_PROMPT };
