// Contract test for the frozen norm_v1 normalizer (docs/NORM-V1-RULE-TABLE.md,
// version 1.0.0; ADR-GKS-ENTITY-RESOLUTION.md decisions 2 and 5).
//
// These assertions pin a FROZEN artifact: normKey's output is stored under
// UNIQUE(scope_key, norm_key), so a failure here is never fixed by editing the
// expectation — a rule change is a new version (norm_v2) with its own module
// and its own table. Every worked example from the rule table appears verbatim.
import { describe, expect, it } from "vitest";
import { NORM_VERSION, normKey } from "@freshair129/gks-core";

describe("norm_v1 normalizer", () => {
  it("normVersion_isTheExactFrozenString", () => {
    expect(NORM_VERSION).toBe("norm_v1");
  });

  it("normKey_rejectsNonStringInput", () => {
    for (const bad of [undefined, null, 42, {}, ["ACME Corp"]]) {
      expect(() => normKey(bad)).toThrow(TypeError);
    }
  });

  // -------------------------------------------------------------------------
  // The rule table's worked examples, verbatim. The first four are the ADR's
  // acceptance criterion 1: the over-split spellings must converge on one key.
  // -------------------------------------------------------------------------
  it.each([
    ["ACME Corp", "acme"],
    ["Acme Corp.", "acme"],
    ["acme corporation", "acme"],
    ["ACME_CORP", "acme"],
    ["บริษัท เอซีเอ็มอี จำกัด", "เอซีเอ็มอี"],
    ["ACME Group Co., Ltd.", "acme group"],
    ["The Acme Company", "acme company"],
  ])("workedExample_%s_producesTableKey", (input, expected) => {
    expect(normKey(input)).toBe(expected);
  });

  it("workedExamples_fourAcmeSpellings_convergeOnOneKey", () => {
    const keys = new Set(
      ["ACME Corp", "Acme Corp.", "acme corporation", "ACME_CORP"].map(normKey),
    );
    expect(keys.size).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Removal discipline: descriptive words are never removed.
  // -------------------------------------------------------------------------
  it("descriptiveWords_group_isKeptWhileLegalSuffixesStrip", () => {
    // A group holding company is a different entity from its operating
    // company; folding "group" would be an over-merge performed by the
    // normalizer, beneath the floor and beneath review.
    const key = normKey("ACME Group Co., Ltd.");
    expect(key).toBe("acme group");
    expect(key).toContain("group");
    expect(normKey("ACME Group Co., Ltd.")).not.toBe(normKey("ACME Corp"));
  });

  // -------------------------------------------------------------------------
  // Whole-token discipline: a token is removed only when it stands alone
  // between separators — never as a substring, and legal-form suffixes only
  // in trailing position.
  // -------------------------------------------------------------------------
  it("wholeToken_incorporated_doesNotStripFromIncorporationServices", () => {
    expect(normKey("Incorporation Services")).toBe("incorporation services");
  });

  it("wholeToken_as_doesNotStripFromAsOne", () => {
    // "as" is the Norwegian legal-form suffix; in "as one" it is not a
    // trailing suffix and must survive.
    expect(normKey("As One")).toBe("as one");
  });

  it("suffix_as_isStrippedOnlyInTrailingPosition", () => {
    expect(normKey("One AS")).toBe("one");
  });

  it("articles_areLeadingPositionOnly", () => {
    // "a" inside a real name is not scaffolding — the table's own example.
    expect(normKey("Bank A")).toBe("bank a");
  });

  // -------------------------------------------------------------------------
  // Thai circumfix: both ends removable independently, and removing one
  // without the other still produces a usable key.
  // -------------------------------------------------------------------------
  it("thaiCircumfix_prefixAloneAndSuffixAlone_bothProduceTheCoreKey", () => {
    expect(normKey("บริษัท เอซีเอ็มอี")).toBe("เอซีเอ็มอี");
    expect(normKey("เอซีเอ็มอี จำกัด")).toBe("เอซีเอ็มอี");
  });

  it("thaiPublicForm_มหาชน_isRemovedAsAWholeToken", () => {
    expect(normKey("บริษัท เอซีเอ็มอี จำกัด มหาชน")).toBe("เอซีเอ็มอี");
  });

  // -------------------------------------------------------------------------
  // Step 6 — the empty guard. A name made purely of scaffolding must fall
  // back to the step-4 output, never the empty key that would merge every
  // such entity into one under UNIQUE(scope_key, norm_key).
  // -------------------------------------------------------------------------
  it("emptyGuard_allScaffoldingName_fallsBackToStepFourOutput", () => {
    // Step 4 output — lowercased, separator-folded, collapsed — not the raw
    // input and not the empty string.
    expect(normKey("Co., Ltd.")).toBe("co ltd");
    expect(normKey("The Co.")).toBe("the co");
    // The fallback is the STEP-4 output, so it is already NFKC-normalized:
    // SARA AM (U+0E33, the ำ in จำกัด) decomposes under NFKC into
    // NIKHAHIT + SARA AA. The raw input string would be the wrong expectation.
    const thaiScaffolding = normKey("บริษัท จำกัด");
    expect(thaiScaffolding).toBe("บริษัท จำกัด".normalize("NFKC"));
    expect(thaiScaffolding).not.toBe("");
  });

  it("emptyGuard_theCompany_neverProducesTheEmptyKey", () => {
    // The rule table motivates the guard with a company literally named
    // "The Company". Under the frozen removal lists "company" is not a
    // removable token (worked example 7 keeps it, by design), so the leading
    // article strips and "company" remains — non-empty either way. What the
    // guard guarantees, and what this pins, is that no such name can ever
    // reach the empty string.
    expect(normKey("The Company")).toBe("company");
    expect(normKey("The Company")).not.toBe("");
    // ...and a distinct all-scaffolding name stays distinct from it.
    expect(normKey("The Company")).not.toBe(normKey("The Co."));
  });

  // -------------------------------------------------------------------------
  // Pipeline steps 1-4.
  // -------------------------------------------------------------------------
  it("nfkc_foldsFullWidthFormsBeforeCasing", () => {
    // Full-width "ＡＣＭＥ" and "Ｃｏｒｐ" (and an ideographic space) fold to
    // the ASCII forms the later steps expect.
    expect(normKey("ＡＣＭＥ　Ｃｏｒｐ")).toBe("acme");
  });

  it("separatorFolding_foldsEveryListedSeparatorToASpace", () => {
    expect(normKey("x_y-z.p,q/r\\s&t+u")).toBe("x y z p q r s t u");
  });

  it("whitespace_collapsesRunsAndTrimsEnds", () => {
    expect(normKey("  ACME \t\n  Corp  ")).toBe("acme");
    expect(normKey("acme   group")).toBe("acme group");
  });

  // -------------------------------------------------------------------------
  // Removal repeats until stable: a removal can expose a new leading article
  // or a new trailing suffix.
  // -------------------------------------------------------------------------
  it("removal_repeatsUntilStable_acrossTokenClasses", () => {
    // Stripping the Thai circumfix exposes a leading article.
    expect(normKey("บริษัท The Acme จำกัด")).toBe("acme");
    // Trailing suffixes pop one after another.
    expect(normKey("Acme Holdings Co Ltd PCL")).toBe("acme holdings");
  });

  it("normKey_isDeterministicAndIdempotent", () => {
    const key = normKey("ACME Group Co., Ltd.");
    expect(normKey("ACME Group Co., Ltd.")).toBe(key);
    // A produced key normalizes to itself — required for the EXACT rung to
    // compare stored keys against fresh ones.
    expect(normKey(key)).toBe(key);
  });
});
