/* HARNESS-ONLY mock of formula-prettifier-eval.js.
 * Re-exports the real pure formatting helpers, but replaces the three network
 * functions (fetchFieldData / evaluateExpression / canRunApex) with instant,
 * deterministic mock data so the panel's evaluate/hover/result states can be
 * reviewed offline. This file is NOT shipped — it exists only for the local
 * UI/UX review harness (fpdev_harness.html). */
export {
  UNABLE_TO_EVALUATE,
  replaceFieldsWithValues,
  isResultHyperlink,
  isResultImage,
  imageEncodingToHtml,
  parseHyperlink,
  formatEncodedFormulaResult
} from "./fpdev_eval_real_copy.js";

// Mock record: Amelia Hartwell / Globex (the "Enterprise" tier lead).
const MOCK_FIELD_VALUES = {
  NumberOfEmployees: 5200,
  AnnualRevenue: 8500000,
  Rating: "Hot",
  Email: "amelia@globex.com",
  Status: "Open - Not Contacted",
  Company: "Globex Corporation",
  FirstName: "Amelia",
  LastName: "Hartwell",
  CreatedDate: "2026-09-27",
  Title: "VP Operations"
};
const MOCK_FIELD_TYPES = {
  NumberOfEmployees: "int",
  AnnualRevenue: "currency",
  Rating: "picklist",
  Email: "email",
  Status: "picklist",
  Company: "string",
  FirstName: "string",
  LastName: "string",
  CreatedDate: "datetime",
  Title: "string"
};

// A per-formula canned "Result:" so the badge shows something realistic.
function mockResultFor(expression) {
  const e = (expression || "").toUpperCase();
  if (e.includes("HYPERLINK")) {
    return "_HL_ENCODED_https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3DGlobex+Corporation_HL_Globex Corporation_HL__blank";
  }
  if (e.includes("ENTERPRISE") || (e.includes("1000") && e.includes("EMPLOYEES"))) return "Enterprise";
  if (e.includes("CASE")) return "100";
  if (e.includes("AND") && e.includes("ISBLANK")) return "true";
  if (e.includes("UPPER") || e.includes("&")) return "Amelia Hartwell (Globex Corporation)";
  if (e.includes("TODAY")) return "0";
  return "Enterprise";
}

export async function fetchFieldData(formula) {
  // Tiny delay so the "Evaluating…" / sparkle states are briefly visible.
  await new Promise(r => setTimeout(r, 250));
  // Simulate the real Apex behavior: multi-line / pretty-printed formula text
  // breaks field extraction. This lets the harness reproduce (and verify the fix
  // for) the "Unable to evaluate after edit" bug.
  if (/[\n\r]/.test(formula || "")) {
    throw new Error("harness: multi-line formula not evaluable");
  }
  return {fieldValues: {...MOCK_FIELD_VALUES}, fieldTypes: {...MOCK_FIELD_TYPES}};
}

export async function evaluateExpression({expression}) {
  await new Promise(r => setTimeout(r, 300));
  if (/[\n\r]/.test(expression || "")) {
    throw new Error("harness: multi-line expression not evaluable");
  }
  return mockResultFor(expression);
}

export async function canRunApex() {
  return true;
}
