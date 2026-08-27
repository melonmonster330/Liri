const test = require("node:test");
const assert = require("node:assert/strict");

const sides = () => import("../app/base/lib/sides.js");

// iTunes-shaped track list — only trackName matters for side resolution.
const tracks = names => names.map(n => ({ trackName: n }));
// Discogs/MusicBrainz-shaped rows from vinyl_releases.vinyl_tracks.
const db = rows => rows.map(([side, n, title]) => ({ side, track_number_on_side: n, title }));

test("side ends come from the same grouping the picker shows", async () => {
  const { getSideEndIndicesFromSides, getSideGroups } = await sides();
  const t = tracks(["one", "two", "three", "four", "five", "six"]);
  const d = db([["A", 1, "one"], ["A", 2, "two"], ["A", 3, "three"],
                ["B", 1, "four"], ["B", 2, "five"], ["B", 3, "six"]]);

  assert.deepEqual(getSideEndIndicesFromSides(t, [], d), [2, 5]);
  // Invariant: every side header the user sees ends where a flip fires.
  const uiEnds = getSideGroups(t, [], d).map(g => g.tracks[g.tracks.length - 1].idx);
  assert.deepEqual(getSideEndIndicesFromSides(t, [], d), uiEnds.sort((a, b) => a - b));
});

test("a side end whose title doesn't match the pressing is not dropped", async () => {
  const { getSideEndIndicesFromSides } = await sides();
  // Real shape of the Fearless (Taylor's Version) regression: the pressing
  // lists a track the digital release spells differently, so title-matching
  // the LAST track of side A used to fail — and that flip silently vanished.
  const t = tracks(["one", "two", "three", "four"]);
  const d = db([["A", 1, "one"], ["A", 2, "two (alternate spelling)"],
                ["B", 1, "three"], ["B", 2, "four"]]);
  assert.deepEqual(getSideEndIndicesFromSides(t, [], d), [1, 3]);
});

test("an unmatched bonus track joins the previous side instead of inventing one", async () => {
  const { getSideEndIndicesFromSides } = await sides();
  const t = tracks(["one", "two", "three", "bonus"]);
  const d = db([["A", 1, "one"], ["A", 2, "two"], ["B", 1, "three"]]);
  // Not [1, 2, 3] — "bonus" must not become a side of its own.
  assert.deepEqual(getSideEndIndicesFromSides(t, [], d), [1, 3]);
});

test("curated vinyl_sides wins over the Discogs fallback, per track", async () => {
  const { getSideEndIndicesFromSides } = await sides();
  const t = tracks(["one", "two", "three", "four"]);
  const vinylSides = [{ side: "A" }, { side: "A" }, { side: "A" }, { side: "B" }];
  const d = db([["A", 1, "one"], ["A", 2, "two"], ["B", 1, "three"], ["B", 2, "four"]]);
  assert.deepEqual(getSideEndIndicesFromSides(t, vinylSides, d), [2, 3]);
});

test("no side data at all returns null so the caller keeps its heuristic", async () => {
  const { getSideEndIndicesFromSides } = await sides();
  assert.equal(getSideEndIndicesFromSides(tracks(["one", "two"]), [], []), null);
  assert.equal(getSideEndIndicesFromSides([], [], db([["A", 1, "one"]])), null);
});

test("a single-sided release ends only at the album end", async () => {
  const { getSideEndIndicesFromSides } = await sides();
  const t = tracks(["one", "two", "three"]);
  const d = db([["A", 1, "one"], ["A", 2, "two"], ["A", 3, "three"]]);
  assert.deepEqual(getSideEndIndicesFromSides(t, [], d), [2]);
});

test("a side ends after its last track, even when the pressing's order differs", async () => {
  const { getSideEndIndicesFromSides } = await sides();
  // Real shape from the catalogue: the digital release orders two side-A tracks
  // differently than the sleeve, so the resolved letters read A A B A B.
  // Flipping at the first A→B change would strand a side-A track on side B.
  const t = tracks(["a1", "a2", "b1", "a3", "b2"]);
  const d = db([["A", 1, "a1"], ["A", 2, "a2"], ["A", 3, "a3"],
                ["B", 1, "b1"], ["B", 2, "b2"]]);
  assert.deepEqual(getSideEndIndicesFromSides(t, [], d), [3, 4]);
});
