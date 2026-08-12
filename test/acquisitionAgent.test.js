/**
 * acquisitionAgent.test.js — acquisition/src/agent.js's selectTracks()
 * logic. Uses an injected mock evaluateFn throughout — no real Claude
 * calls in the automated suite (cost + flakiness + this repo's existing
 * convention of never hitting a real LLM from `npx hardhat test`). The
 * real Claude judgment call itself (evaluateFit) is exercised live via
 * scripts/cli/demo-acquisition.js, not here — see CHANGELOG.md for that
 * verification's actual output.
 *
 * Run: npx hardhat test
 */

const { expect } = require("chai");

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "unused-in-tests";
const { selectTracks } = require("../acquisition/src/agent");

const CATALOG = [
  { id: "t1", title: "Track One" },
  { id: "t2", title: "Track Two" },
  { id: "t3", title: "Track Three" },
  { id: "t4", title: "Track Four" },
];

function fitAll() {
  return async (brief, track) => ({ fits: true, reason: `mock: ${track.id} fits "${brief}"` });
}
function fitNone() {
  return async (brief, track) => ({ fits: false, reason: `mock: ${track.id} does not fit` });
}
function fitByIds(ids) {
  return async (brief, track) => ({ fits: ids.includes(track.id), reason: `mock: ${track.id}` });
}

describe("AcquisitionAgent (acquisition/src/agent.js)", function () {
  describe("selectTracks — budget constraint", function () {
    it("selects exactly floor(budget/pricePerTrack) tracks when more fit than the budget allows", async function () {
      const result = await selectTracks({
        brief: "energetic late-90s alt-rock, female vocals, no explicit lyrics",
        budget: 2.0,
        pricePerTrack: 1.0,
        catalog: CATALOG, // all 4 will "fit" per fitAll()
        evaluateFn: fitAll(),
      });
      expect(result.selected).to.have.lengthOf(2);
      expect(result.totalCost).to.equal(2.0);
    });

    it("selects zero tracks when budget is below one track's price", async function () {
      const result = await selectTracks({
        brief: "anything",
        budget: 0.5,
        pricePerTrack: 1.0,
        catalog: CATALOG,
        evaluateFn: fitAll(),
      });
      expect(result.selected).to.have.lengthOf(0);
      expect(result.totalCost).to.equal(0);
    });

    it("selects fewer than the budget allows when fewer tracks fit", async function () {
      const result = await selectTracks({
        brief: "anything",
        budget: 10.0,
        pricePerTrack: 1.0,
        catalog: CATALOG,
        evaluateFn: fitByIds(["t2"]),
      });
      expect(result.selected).to.have.lengthOf(1);
      expect(result.selected[0].id).to.equal("t2");
    });

    it("respects a non-default pricePerTrack", async function () {
      const result = await selectTracks({
        brief: "anything",
        budget: 3.0,
        pricePerTrack: 1.5,
        catalog: CATALOG,
        evaluateFn: fitAll(),
      });
      expect(result.selected).to.have.lengthOf(2); // floor(3.0 / 1.5) = 2
      expect(result.totalCost).to.equal(3.0);
    });
  });

  describe("selectTracks — never selects a track outside the input catalog", function () {
    it("every selected track is a reference from the input catalog", async function () {
      const result = await selectTracks({
        brief: "anything", budget: 100, catalog: CATALOG, evaluateFn: fitAll(),
      });
      for (const t of result.selected) {
        expect(CATALOG).to.include(t); // reference equality — not a copy, not invented
      }
    });

    it("selects nothing when nothing fits, even with unlimited budget", async function () {
      const result = await selectTracks({
        brief: "anything", budget: 100, catalog: CATALOG, evaluateFn: fitNone(),
      });
      expect(result.selected).to.have.lengthOf(0);
    });
  });

  describe("selectTracks — evaluation coverage and ordering", function () {
    it("evaluates every candidate exactly once, regardless of fit outcome", async function () {
      const result = await selectTracks({
        brief: "anything", budget: 100, catalog: CATALOG, evaluateFn: fitByIds(["t1", "t3"]),
      });
      expect(result.evaluations).to.have.lengthOf(CATALOG.length);
      expect(result.evaluations.map((e) => e.track.id)).to.deep.equal(["t1", "t2", "t3", "t4"]);
    });

    it("preserves catalog order among selected tracks (budget cutoff, not a re-ranking)", async function () {
      const result = await selectTracks({
        brief: "anything", budget: 100, pricePerTrack: 1.0,
        catalog: CATALOG, evaluateFn: fitByIds(["t4", "t1", "t3"]),
      });
      // fits are t1, t3, t4 in catalog order — not the callback's own order
      expect(result.selected.map((t) => t.id)).to.deep.equal(["t1", "t3", "t4"]);
    });

    it("carries each evaluation's written reason through", async function () {
      const result = await selectTracks({
        brief: "moody synthwave", budget: 100, catalog: CATALOG, evaluateFn: fitAll(),
      });
      for (const e of result.evaluations) {
        expect(e.reason).to.be.a("string").and.not.empty;
      }
    });
  });

  describe("selectTracks — input validation", function () {
    it("throws on an empty brief", async function () {
      let threw = false;
      try { await selectTracks({ brief: "", budget: 1, catalog: CATALOG, evaluateFn: fitAll() }); }
      catch (e) { threw = true; }
      expect(threw).to.equal(true);
    });

    it("throws on a non-positive budget", async function () {
      let threw = false;
      try { await selectTracks({ brief: "x", budget: 0, catalog: CATALOG, evaluateFn: fitAll() }); }
      catch (e) { threw = true; }
      expect(threw).to.equal(true);
    });

    it("throws on an empty catalog", async function () {
      let threw = false;
      try { await selectTracks({ brief: "x", budget: 1, catalog: [], evaluateFn: fitAll() }); }
      catch (e) { threw = true; }
      expect(threw).to.equal(true);
    });
  });
});
