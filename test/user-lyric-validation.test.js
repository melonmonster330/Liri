const test = require("node:test");
const assert = require("node:assert/strict");
const { validateUserLyricSubmission, signature } = require("../api/_lib/user-lyric-validation");

test("accepts and normalizes common LRC timestamps", () => {
  const result = validateUserLyricSubmission({
    lrc_raw: "[0:01]First line\n[00:05.2]Second line\n[00:09.25]Third line\n[00:13.250]Fourth line",
  }, 30000);
  assert.equal(result.ok, true);
  assert.match(result.lrc, /^\[00:01\.000\]First line/);
  assert.equal(result.plain.split("\n").length, 4);
});

test("rejects out-of-order and overlong LRC", () => {
  const backwards = validateUserLyricSubmission({
    lrc_raw: "[00:01]One\n[00:08]Two\n[00:05]Three\n[00:12]Four",
  }, 30000);
  assert.equal(backwards.ok, false);
  assert.match(backwards.reason, /out of order/);

  const overrun = validateUserLyricSubmission({
    lrc_raw: "[00:01]One\n[00:08]Two\n[00:15]Three\n[01:00]Four",
  }, 30000);
  assert.equal(overrun.ok, false);
  assert.match(overrun.reason, /overrun/);
});

test("plain submissions must be substantial and webpage-free", () => {
  assert.equal(validateUserLyricSubmission({ lyrics_plain: "one\ntwo\nthree\nfour" }).ok, false);
  assert.equal(validateUserLyricSubmission({ lyrics_plain: "<html>copied page with several lines and lots of text</html>\nline two\nline three\nline four" }).ok, false);
  assert.equal(validateUserLyricSubmission({ lyrics_plain: [
    "A sufficiently long first supplied line for validation",
    "A sufficiently long second supplied line for validation",
    "A sufficiently long third supplied line for validation",
    "A sufficiently long fourth supplied line for validation",
  ].join("\n") }).ok, true);
});

test("consensus signatures ignore casing and whitespace only", () => {
  assert.equal(signature("Hello   World\nAgain"), signature(" hello world again "));
  assert.notEqual(signature("Hello world"), signature("Hello different world"));
});
