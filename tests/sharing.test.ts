import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReportShareUrl, readReportLink, validReportId } from "../src/reportSharing.js";

test("shared links contain only an opaque public report ID on the supplied origin", () => {
  const link = buildReportShareUrl(
    "https://user:password@passo.example:8443/old/path?latitude=45&session=private#position",
    "report_A-19",
  );
  assert.equal(link, "https://passo.example:8443/?segnalazione=report_A-19");
  assert.deepEqual(readReportLink(new URL(link).search), { id: "report_A-19", invalid: false });
  assert.equal(buildReportShareUrl("http://localhost:5173", "legacy-report"), "http://localhost:5173/?segnalazione=legacy-report");
  assert.throws(() => buildReportShareUrl("javascript:alert(1)", "valid-report"), TypeError);
});

test("rejects malformed, ambiguous and oversized deep links without treating missing links as errors", () => {
  for (const search of ["", "?category=mud", "?Segnalazione=case-sensitive"]) {
    assert.deepEqual(readReportLink(search), { id: null, invalid: false });
  }
  for (const search of [
    "?segnalazione=", "?segnalazione=one&segnalazione=two", "?segnalazione=one&%73egnalazione=one",
    "?segnalazione=%2Fapi%2Freports", "?segnalazione=report%0A", "?segnalazione=report%00",
    "?segnalazione=two+words", "?segnalazione=%E0%A4%A", `?segnalazione=${"a".repeat(129)}`,
  ]) {
    assert.deepEqual(readReportLink(search), { id: null, invalid: true }, search);
  }
  for (const value of [null, undefined, 1, {}, "", "a\n", "a\r", "a/b", "a b", "è", "a".repeat(129)]) {
    assert.equal(validReportId(value), false);
  }
  assert.equal(validReportId("a".repeat(128)), true);
  assert.deepEqual(readReportLink("?segnalazione=%6Cegacy-report"), { id: "legacy-report", invalid: false });
  assert.throws(() => buildReportShareUrl("https://passo.example", "valid\n"), TypeError);
});
