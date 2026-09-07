/* global React ReactDOM */
/* Formula Prettifier — extension page (renders inside the injected iframe).
 *
 * This is the window BODY of the Formula Prettifier: the input-mode toggle
 * (Select Formula Field / Paste Formula), the object/field pickers, the
 * prettify action, and the syntax-highlighted output (line gutter, collapsible
 * regions, rainbow brackets). The window chrome (draggable/resizable frame,
 * header, min/max/close) is provided by the outer wrapper injected on the
 * Salesforce page by button.js.
 *
 * The formatting/tokenizing engine is the faithful port in
 * formula-prettifier-core.js. Salesforce data access (object/field lists,
 * formula text, evaluation) goes through sfConn (inspector.js).
 */
import {sfConn} from "./inspector.js";
import {getFieldSetupLinks} from "./setup-links.js";
import {prettify, FORMULA_FUNCTIONS, extractFunctionExpression} from "./formula-prettifier-core.js";
import {getObjectList, getFormulaFieldsForObject, getFieldFormula} from "./formula-prettifier-data.js";
import {fetchFieldData, evaluateExpression, replaceFieldsWithValues, formatEncodedFormulaResult, canRunApex, UNABLE_TO_EVALUATE} from "./formula-prettifier-eval.js";

let h = React.createElement;

const INPUT_MODE = {PASTE: "paste", SELECT: "select"};

const BLANK_FIELD_OPTIONS = [
  {label: "Zeroes", value: "BlankAsZero"},
  {label: "Blanks", value: "BlankAsBlank"}
];

// Extract a human-readable message from an sfConn / Salesforce API error, which
// may be an Error, a {message}, an array of {message, errorCode}, or a string.
function errMsg(e) {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  if (Array.isArray(e)) return e.map(errMsg).join("; ");
  if (e.message) return e.message;
  if (e.error) return errMsg(e.error);
  if (e.errorCode) return e.errorCode;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// Field-level help text, matching the AppExchange app.
const HELP_OBJECT = "All objects accessible to you are available to select from. If you don't see the object you're looking for, please make sure you have access to it. Once selected, only that object's formula fields will be available in the Field list.";
const HELP_FIELD = "Only formula fields are available to select from. If you don't see the field you're looking for, please make sure you can access the field.";
const HELP_BLANK = "If your formula references any number, currency, or percent fields, specify what happens to the formula output when their values are blank. If you are unsure about what to select, please use the same value as configured in the field via advanced formula setup.";
// Result-badge help text (two variants, exactly as the app's resultHelpText).
const HELP_RESULT_OK = "Formula is evaluated considering the 'Treat blank fields as' setting configured above. If you think the result is not as expected, make sure that setting is configured correctly.";
const HELP_RESULT_FAIL = "Make sure you're on the right record page and have access to all fields and variables referenced in the formula. If still not working, please report the issue so we can look into it.";

class Model {
  constructor(sfHost, contextObject, contextRecordId) {
    this.sfHost = sfHost;
    this.reactCallback = null;

    // Current record-page context (from the Salesforce URL, passed by the
    // launcher) — used to auto-select the object on open.
    this.contextObject = contextObject || "";
    this.contextRecordId = contextRecordId || "";
    this.autoSelectedObject = false; // guard so we auto-select the object once

    this.inputMode = INPUT_MODE.SELECT;

    // Paste-mode buffers — kept fully separate from Select-mode so the two
    // modes never overwrite each other's formula/result/values (like the app).
    this.pastedRawFormula = "";
    this.pastedResult = null; // {prettified, lines}
    this.pasteModeBlankFieldHandling = "BlankAsZero";
    this.pastedFormulaResult = "";
    this.pastedFieldValues = null;
    this.pastedFieldTypes = null;

    // Select-mode buffers
    this.selectedRawFormula = "";
    this.selectedResult = null;
    this.selectModeBlankFieldHandling = "BlankAsZero";
    this.selectedFormulaResult = "";
    this.selectedFieldValues = null;
    this.selectedFieldTypes = null;

    // Object/field pickers
    this.objectOptions = [];
    this.fieldOptions = [];
    this.selectedObject = "";
    this.selectedField = "";
    this.isLoadingObjects = false;
    this.isLoadingFields = false;

    this.isLoading = false;
    this.errorMessage = "";
    this.infoMessage = "";

    this.formulaFunctions = FORMULA_FUNCTIONS;

    // --- Live evaluation state ---
    // The data type of the selected formula field (drives Percent scaling in
    // Apex formatResult; only set/used in Select mode, like the app).
    this.selectedFieldDataType = "";
    // formulaResult / fieldValues / fieldTypes are per-mode (see getters below).
    this.isEvaluatingFullFormula = false;
    // Whether the running user can run anonymous Apex (null until checked).
    this.apexAllowed = null;
    // Tooltip state for on-hover sub-expression evaluation.
    this.tooltip = null; // {content, x, y, evaluating, tokenId}
    // The bracket pair id currently highlighted (both partners glow on hover).
    this.hoveredBracketPairId = null;
  }

  didUpdate() {
    if (this.reactCallback) {
      this.reactCallback();
    }
  }

  get isPasteMode() { return this.inputMode === INPUT_MODE.PASTE; }
  get isSelectMode() { return this.inputMode === INPUT_MODE.SELECT; }

  get rawFormula() {
    return this.isPasteMode ? this.pastedRawFormula : this.selectedRawFormula;
  }
  set rawFormula(v) {
    if (this.isPasteMode) this.pastedRawFormula = v; else this.selectedRawFormula = v;
  }

  get result() {
    return this.isPasteMode ? this.pastedResult : this.selectedResult;
  }
  set result(v) {
    if (this.isPasteMode) this.pastedResult = v; else this.selectedResult = v;
  }

  // Per-mode evaluation state — Paste and Select keep independent results and
  // field values so switching modes never overwrites the other's data.
  get formulaResult() {
    return this.isPasteMode ? this.pastedFormulaResult : this.selectedFormulaResult;
  }
  set formulaResult(v) {
    if (this.isPasteMode) this.pastedFormulaResult = v; else this.selectedFormulaResult = v;
  }
  get fieldValues() {
    return this.isPasteMode ? this.pastedFieldValues : this.selectedFieldValues;
  }
  set fieldValues(v) {
    if (this.isPasteMode) this.pastedFieldValues = v; else this.selectedFieldValues = v;
  }
  get fieldTypes() {
    return this.isPasteMode ? this.pastedFieldTypes : this.selectedFieldTypes;
  }
  set fieldTypes(v) {
    if (this.isPasteMode) this.pastedFieldTypes = v; else this.selectedFieldTypes = v;
  }

  get formattedLines() {
    return this.result ? this.result.lines : [];
  }
  get prettifiedText() {
    return this.result ? this.result.prettified : "";
  }

  // Like the app: the output is "ready" only when nothing is loading/evaluating.
  // While evaluating, the sparkle loader shows instead of the prettified output.
  get isReady() {
    return !this.isLoading && !this.isEvaluatingFullFormula;
  }
  get showOutputSection() {
    return this.isReady && this.result && this.result.lines.length > 0;
  }
  get showPrettifyButton() {
    return this.isPasteMode && this.pastedRawFormula.trim().length > 0 && !this.pastedResult;
  }
  get noPastedFormula() {
    return this.pastedRawFormula.trim().length === 0;
  }
  get noFieldSelected() {
    return !this.selectedField;
  }
  get refreshButtonDisabled() {
    return this.isSelectMode ? this.noFieldSelected : this.noPastedFormula;
  }

  // Display label for the currently-selected object / field (for the typeaheads).
  get selectedObjectLabel() {
    const o = this.objectOptions.find(x => x.value === this.selectedObject);
    return o ? o.label : this.selectedObject;
  }
  get selectedFieldLabel() {
    const f = this.fieldOptions.find(x => x.value === this.selectedField);
    return f ? f.label : this.selectedField;
  }

  // --- Live evaluation gating (mirrors the app's canEvaluateFormula) ---------
  // Evaluation needs a record to evaluate against and an object. In Select mode
  // the selected object must match the record-page object (we can only evaluate
  // against the open record). Also requires the Author-Apex permission.
  get canEvaluateFormula() {
    if (this.apexAllowed === false) return false;
    if (!this.contextRecordId) return false;
    const obj = this.isSelectMode ? this.selectedObject : this.contextObject;
    if (!obj) return false;
    if (this.isSelectMode && this.selectedObject !== this.contextObject) return false;
    return true;
  }
  // The object + record we evaluate against.
  get evalObject() {
    return this.isSelectMode ? this.selectedObject : this.contextObject;
  }
  get blankFieldHandling() {
    return this.isSelectMode ? this.selectModeBlankFieldHandling : this.pasteModeBlankFieldHandling;
  }
  get showResultBadge() {
    // Output only shows when ready (not evaluating), so the badge just needs a
    // result to display.
    return this.showOutputSection && this.formulaResult !== "";
  }
  // Display form of the evaluated result — HYPERLINK / IMAGE encodings become
  // the HTML Salesforce would render; everything else is unchanged.
  get displayFormulaResult() {
    return formatEncodedFormulaResult(this.formulaResult);
  }
  get resultHelpText() {
    return this.formulaResult === UNABLE_TO_EVALUATE ? HELP_RESULT_FAIL : HELP_RESULT_OK;
  }

  setInputMode(mode) {
    // Each mode keeps its own formula/result/values (per-mode getters), so
    // switching modes simply shows the other mode's existing state — nothing is
    // reset or overwritten, exactly like the app.
    this.inputMode = mode;
    this.didUpdate();
  }

  // --- Prettify -------------------------------------------------------------
  runPrettify() {
    const raw = this.rawFormula;
    if (!raw || !raw.trim()) {
      this.result = null;
      this.didUpdate();
      return;
    }
    this.result = prettify(raw, this.formulaFunctions);
    this.didUpdate();
    this.startEvaluation(raw);
  }

  onPasteFormulaChange(value) {
    // Like the app: editing the pasted formula only updates the raw text. The
    // existing prettified output stays until the user clicks Refresh; the
    // Prettify button only appears before the first prettify (no output yet).
    this.pastedRawFormula = value;
    this.didUpdate();
  }

  // Refresh re-prettifies the current input, mirroring the app: in Select mode
  // it re-derives from the selected field's formula; in Paste mode it re-runs
  // on the (possibly edited) pasted formula.
  refresh() {
    let raw = "";
    if (this.isSelectMode) {
      if (this.selectedRawFormula) {
        raw = this.selectedRawFormula;
        this.result = prettify(raw, this.formulaFunctions);
      }
    } else if (this.pastedRawFormula && this.pastedRawFormula.trim()) {
      raw = this.pastedRawFormula;
      this.result = prettify(raw, this.formulaFunctions);
    }
    this.didUpdate();
    if (raw) this.startEvaluation(raw);
  }

  // --- Collapse / expand (ported verbatim from the app) ---------------------
  // Toggle a collapsible line's block: flip isCollapsed and hide/show the lines
  // between it and its matching closing line.
  toggleCollapse(lineId, collapseDepth) {
    const lines = this.formattedLines;
    const targetLine = lines[lineId];
    if (!targetLine) return;

    targetLine.isCollapsed = !targetLine.isCollapsed;
    targetLine.collapsedDepth = collapseDepth;

    const closingLineId = this.findClosingLine(lineId, collapseDepth);
    if (closingLineId !== null) {
      this.updateLineVisibility(lineId, closingLineId, targetLine.isCollapsed);
      lines[closingLineId].isHidden = false;
    }
    this.didUpdate();
  }

  // Find the line where this collapsible block closes (matching bracket depth).
  findClosingLine(lineId, collapseDepth) {
    const lines = this.formattedLines;
    let depthCounter = 1;
    for (let i = lineId + 1; i < lines.length; i++) {
      for (const token of lines[i].tokens) {
        if (token.type === "bracket" && token.bracketDepth === collapseDepth) {
          if (token.text === "(") {
            depthCounter++;
          } else if (token.text === ")") {
            depthCounter--;
            if (depthCounter === 0) return i;
          }
        }
      }
    }
    return null;
  }

  // Hide (collapsing) or show (expanding) the lines within a block. When
  // expanding, a line stays hidden if it's still inside another collapsed block.
  updateLineVisibility(startLine, endLine, isCollapsing) {
    const lines = this.formattedLines;
    for (let i = startLine + 1; i < endLine; i++) {
      lines[i].isHidden = isCollapsing ? true : this.isLineInCollapsedBlock(i);
    }
  }

  // True if the line falls inside any other still-collapsed block.
  isLineInCollapsedBlock(lineId) {
    const lines = this.formattedLines;
    for (let j = 0; j < lineId; j++) {
      const line = lines[j];
      if (line.isCollapsed && line.collapsedDepth !== undefined) {
        const closingLineId = this.findClosingLine(j, line.collapsedDepth);
        if (closingLineId !== null && lineId > j && lineId < closingLineId) {
          return true;
        }
      }
    }
    return false;
  }

  // --- Live evaluation ------------------------------------------------------
  // Full-formula evaluation, mirroring the app: fetch the formula's field
  // values/types once (phase 1), then substitute + evaluate (phase 2). The
  // fetched values are cached on the model so on-hover sub-expression
  // evaluation can reuse them without re-querying.
  async startEvaluation(rawFormula) {
    // Reset prior result.
    this.formulaResult = "";
    this.fieldValues = null;
    this.fieldTypes = null;

    // Lazily check the Author-Apex permission once.
    if (this.apexAllowed === null) {
      this.apexAllowed = await canRunApex();
    }
    if (!this.canEvaluateFormula) {
      // Not evaluable here (no record / mismatched object / no permission) —
      // formatting still works; just no Result badge.
      this.didUpdate();
      return;
    }

    this.isEvaluatingFullFormula = true;
    this.didUpdate();
    try {
      // Phase 1: fetch field values + types for this formula's references.
      const data = await fetchFieldData(rawFormula, this.evalObject, this.contextRecordId);
      this.fieldValues = data.fieldValues;
      this.fieldTypes = data.fieldTypes;

      // Phase 2: substitute client-side, then evaluate via Formula.builder().
      const expression = replaceFieldsWithValues(rawFormula, this.fieldValues, this.fieldTypes);
      this.formulaResult = await evaluateExpression({
        expression,
        objectApiName: this.evalObject,
        recordId: this.contextRecordId,
        blankFieldHandling: this.blankFieldHandling,
        // fieldDataType only in Select mode (drives Percent scaling), like the app.
        fieldDataType: this.isSelectMode ? this.selectedFieldDataType : ""
      });
    } catch (e) {
      console.error("Formula Prettifier: evaluation failed", e);
      this.formulaResult = UNABLE_TO_EVALUATE;
    } finally {
      this.isEvaluatingFullFormula = false;
      this.didUpdate();
    }
  }

  // Whether a field reference has a fetched value to show on hover.
  hasFieldValue(fieldText) {
    return !!this.fieldValues && Object.prototype.hasOwnProperty.call(this.fieldValues, fieldText);
  }

  // Hovering a FIELD token shows its fetched value (no Apex call). Mirrors the
  // app: null -> "null"; undefined -> no tooltip; else the value as a string.
  onFieldHover(event, fieldText) {
    if (!this.canEvaluateFormula || !this.hasFieldValue(fieldText)) return;
    const fieldValue = this.fieldValues[fieldText];
    if (fieldValue === undefined) return;
    const displayValue = fieldValue === null ? "null" : String(fieldValue);
    this.showTooltip(event.target, displayValue, "field-" + fieldText);
  }

  // Entry point from a hovered FUNCTION token: extract its balanced sub-
  // expression and evaluate it. tokenId ties the async result back to this
  // specific hover so a stale result doesn't overwrite a newer one.
  onFunctionHover(event, lineIndex, functionName) {
    if (!this.canEvaluateFormula || !this.fieldValues) return;
    const subExpression = extractFunctionExpression(this.formattedLines, lineIndex, functionName);
    if (!subExpression) return;
    const tokenId = lineIndex + "-function-" + functionName;
    const anchor = event.target;
    this.evaluateSubExpression(subExpression, tokenId, anchor);
  }

  // On-hover sub-expression evaluation. Reuses the already-fetched field
  // values/types (no phase-1 re-query) — substitute the sub-expression and
  // evaluate. `fieldDataType` is intentionally omitted (no Percent scaling on
  // hover), matching the app.
  async evaluateSubExpression(subExpression, tokenId, anchor) {
    if (!this.canEvaluateFormula || !this.fieldValues) return;
    this.showTooltip(anchor, "", tokenId, true);
    try {
      const expression = replaceFieldsWithValues(subExpression, this.fieldValues, this.fieldTypes);
      const result = await evaluateExpression({
        expression,
        objectApiName: this.evalObject,
        recordId: this.contextRecordId,
        blankFieldHandling: this.blankFieldHandling,
        fieldDataType: ""
      });
      // Only apply if still hovering the same token.
      if (this.tooltip && this.tooltip.tokenId === tokenId) {
        this.showTooltip(anchor, formatEncodedFormulaResult(result), tokenId, false);
      }
    } catch {
      if (this.tooltip && this.tooltip.tokenId === tokenId) {
        this.showTooltip(anchor, UNABLE_TO_EVALUATE, tokenId, false);
      }
    }
  }

  // Position the formula tooltip above `anchor`. Final left/arrow are refined
  // by FormulaTooltip after it measures its real width so short and long
  // content both stay centered on the token without clipping the iframe.
  showTooltip(anchor, content, tokenId, evaluating) {
    const rect = anchor.getBoundingClientRect();
    const placeAbove = rect.top >= 48;
    this.tooltip = {
      content,
      anchorX: rect.left + (rect.width / 2),
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      placeAbove,
      evaluating: !!evaluating,
      tokenId
    };
    this.didUpdate();
  }

  hideTooltip() {
    if (this.tooltip) {
      this.tooltip = null;
      this.didUpdate();
    }
  }

  // Bracket-pair highlight on hover: both brackets sharing the id glow together
  // (like the app). State-driven so it survives re-renders without DOM fiddling.
  highlightBracketPair(bracketPairId) {
    if (this.hoveredBracketPairId !== bracketPairId) {
      this.hoveredBracketPairId = bracketPairId;
      this.didUpdate();
    }
  }
  clearBracketHighlight() {
    if (this.hoveredBracketPairId !== null) {
      this.hoveredBracketPairId = null;
      this.didUpdate();
    }
  }

  // Check (once) whether the running user can run anonymous Apex; re-render so
  // the evaluation UI appears/hides accordingly.
  async checkApexPermission() {
    if (this.apexAllowed !== null) return;
    this.apexAllowed = await canRunApex();
    this.didUpdate();
  }

  // --- Select mode: object/field pickers ------------------------------------
  // Step 1: load the object list once (FieldDefinition can't be queried across
  // all objects, so formula fields are loaded lazily per object below).
  async loadObjects() {
    if (this.objectOptions.length > 0 || this.isLoadingObjects) {
      return;
    }
    this.isLoadingObjects = true;
    this.errorMessage = "";
    this.didUpdate();
    try {
      this.objectOptions = await getObjectList(this.sfHost);
    } catch (e) {
      this.errorMessage = "Could not load objects: " + errMsg(e);
      console.error("Formula Prettifier: loadObjects failed", e);
    } finally {
      this.isLoadingObjects = false;
      this.didUpdate();
      // On a record page, auto-select the current object (once). Keep
      // contextObject intact — canEvaluateFormula depends on it.
      if (this.contextObject && !this.autoSelectedObject && !this.selectedObject
          && this.objectOptions.some(o => o.value === this.contextObject)) {
        this.autoSelectedObject = true;
        this.onSelectObject(this.contextObject);
      }
    }
  }

  get isLoadingObjectsAndFields() {
    return this.isLoadingObjects;
  }

  // Step 2: when an object is picked, load only that object's formula fields.
  async onSelectObject(objectApiName) {
    this.selectedObject = objectApiName;
    this.selectedField = "";
    this.selectedRawFormula = "";
    this.selectedResult = null;
    this.fieldOptions = [];
    this.infoMessage = "";
    if (!objectApiName) {
      this.didUpdate();
      return;
    }
    this.isLoadingFields = true;
    this.errorMessage = "";
    this.didUpdate();
    try {
      this.fieldOptions = await getFormulaFieldsForObject(objectApiName);
      this.infoMessage = this.fieldOptions.length === 0
        ? "This object has no formula fields accessible to you."
        : "";
    } catch (e) {
      this.errorMessage = "Could not load formula fields: " + errMsg(e);
      console.error("Formula Prettifier: getFormulaFieldsForObject failed", e);
    } finally {
      this.isLoadingFields = false;
      this.didUpdate();
    }
  }

  async onSelectField(fieldApiName) {
    this.selectedField = fieldApiName;
    this.selectedResult = null;
    this.formulaResult = "";
    // Capture the field's data type (for Percent scaling in evaluation).
    const opt = this.fieldOptions.find(o => o.value === fieldApiName);
    this.selectedFieldDataType = opt ? (opt.dataType || "") : "";
    if (!fieldApiName) {
      this.didUpdate();
      return;
    }
    this.isLoading = true;
    this.errorMessage = "";
    this.didUpdate();
    try {
      const formula = await getFieldFormula(this.selectedObject, fieldApiName);
      this.selectedRawFormula = formula || "";
      this.selectedResult = formula ? prettify(formula, this.formulaFunctions) : null;
    } catch (e) {
      this.errorMessage = "Could not load the formula: " + errMsg(e);
      console.error("Formula Prettifier: getFieldFormula failed", e);
    } finally {
      this.isLoading = false;
      this.didUpdate();
      // Kick off evaluation for the loaded formula.
      if (this.selectedRawFormula) this.startEvaluation(this.selectedRawFormula);
    }
  }

  async copyPrettified() {
    const text = this.prettifiedText;
    if (!text) return false;
    // navigator.clipboard can be unavailable/blocked inside a cross-origin
    // iframe, so fall back to execCommand on a temporary textarea.
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn("Formula Prettifier: clipboard API failed, falling back", e);
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      console.error("Formula Prettifier: copy failed", e);
      return false;
    }
  }

  // Open the selected field's detail page in Salesforce Setup (new tab). Reuses
  // the Inspector's shared getFieldSetupLinks (setup-links.js), which resolves
  // the exact field durable id so we land on THAT field, not just the object's
  // field list.
  async openFieldInSetup() {
    if (!this.selectedObject || !this.selectedField) return;
    try {
      const links = await getFieldSetupLinks(this.sfHost, this.selectedObject, this.selectedField);
      const url = links && links.lightningSetupLink;
      if (url) {
        window.open(url, "_blank");
      }
    } catch (e) {
      console.error("Formula Prettifier: openFieldInSetup failed", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Presentational components
// ---------------------------------------------------------------------------

// An SLDS icon from the extension's symbols.svg sprite (same-origin in this
// iframe page, so it can be referenced directly by id). Rendered in the app's
// purple; pointer-events:none so clicks land on the parent button.
function icon(name, sizeClass = "slds-icon_x-small") {
  return h("svg", {
    className: "fp-icon " + sizeClass,
    "aria-hidden": "true",
    style: {fill: "currentColor", pointerEvents: "none"}
  },
  h("use", {xlinkHref: "symbols.svg#" + name})
  );
}

function SparkleLoader({title}) {
  return h("div", {className: "sparkle-loader"},
    h("div", {className: "sparkle-container", title: title || "Prettifying..."},
      h("div", {className: "sparkle"}, "✨"),
      h("div", {className: "sparkle"}, "✨"),
      h("div", {className: "sparkle"}, "✨"),
      h("div", {className: "sparkle"}, "✨")
    ),
    title ? h("div", {className: "loading-text"}, title) : null
  );
}

// Mirrors the app's updateToggleSlider(): measures the two buttons and sets
// --select-width / --paste-width so the sliding pill exactly covers whichever
// button is active (the two labels have different widths).
class ModeToggle extends React.Component {
  componentDidMount() { this.syncSlider(); }
  componentDidUpdate() { this.syncSlider(); }
  syncSlider() {
    // React 15 (this build) supports string refs, not React.createRef.
    const container = this.refs.container;
    if (!container) return;
    const selectBtn = container.querySelector("[data-button=\"select\"]");
    const pasteBtn = container.querySelector("[data-button=\"paste\"]");
    if (selectBtn && pasteBtn) {
      container.style.setProperty("--select-width", selectBtn.offsetWidth + "px");
      container.style.setProperty("--paste-width", pasteBtn.offsetWidth + "px");
    }
  }
  render() {
    const {model, onSelect} = this.props;
    return h("div", {className: "slds-m-bottom_medium"},
      h("div", {className: "toggle-container", "data-mode": model.inputMode, ref: "container"},
        h("div", {className: "toggle-slider"}),
        h("button", {
          className: "toggle-button" + (model.isSelectMode ? " active" : ""),
          type: "button",
          "data-button": "select",
          onClick: () => onSelect(INPUT_MODE.SELECT)
        }, "Select Formula Field"),
        h("button", {
          className: "toggle-button" + (model.isPasteMode ? " active" : ""),
          type: "button",
          "data-button": "paste",
          onClick: () => onSelect(INPUT_MODE.PASTE)
        }, "Paste Formula")
      )
    );
  }
}

// Shared label + optional help icon.
// Info icon that shows a styled SLDS tooltip popover on hover/focus, matching
// the app's lightning-helptext behavior. The popover is rendered with
// position:fixed (viewport coords) at a high z-index so it's never clipped by
// the window/output overflow or the header bar, and it intelligently flips to
// whichever side (top/bottom/left/right) has room — like Salesforce's helptext.
const HELP_TOOLTIP_W = 260;
const HELP_GAP = 10; // gap between icon and tooltip

class HelpIcon extends React.Component {
  constructor(props) {
    super(props);
    this.state = {open: false, style: null, nubbin: "bottom-left"};
  }
  open() {
    const el = this.refs.icon;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The tooltip renders inside the iframe, so it must stay within the iframe's
    // width/height (window.inner*), not the browser viewport.
    const vw = window.innerWidth;
    const margin = 8;
    const estH = 120; // rough tooltip height (fixed width, text wraps)
    const cx = r.left + (r.width / 2);

    // Vertical placement: prefer above (like the app), else below.
    const placeAbove = r.top >= estH + HELP_GAP;

    // Horizontal: center on the icon, then CLAMP so the whole box stays on
    // screen.
    let left = cx - (HELP_TOOLTIP_W / 2);
    left = Math.max(margin, Math.min(left, vw - HELP_TOOLTIP_W - margin));

    // Place a custom arrow at the EXACT pixel offset of the icon center within
    // the (possibly clamped) tooltip box, so it always points right at the icon.
    const arrowLeft = Math.max(12, Math.min(cx - left, HELP_TOOLTIP_W - 12));

    const top = placeAbove ? (r.top - HELP_GAP) : (r.bottom + HELP_GAP);
    const style = {
      left: left + "px",
      top: top + "px",
      transform: placeAbove ? "translateY(-100%)" : "none"
    };
    this.setState({open: true, style, placeAbove, arrowLeft});
  }
  close() {
    this.setState({open: false, style: null});
  }
  render() {
    // The arrow is a real child element (not a CSS var) because React 15 drops
    // CSS custom properties from inline styles. A standard `left` on the span
    // works, so it points exactly at the icon regardless of clamping.
    return h("span", {
      className: "fp-help-icon",
      ref: "icon",
      onMouseEnter: () => this.open(),
      onMouseLeave: () => this.close(),
      onFocus: () => this.open(),
      onBlur: () => this.close(),
      tabIndex: 0
    },
    h("svg", {className: "slds-icon slds-icon_xx-small", "aria-hidden": "true"},
      h("use", {xlinkHref: "symbols.svg#info"})),
    this.state.open && this.state.style
      ? h("div", {
        className: "slds-popover slds-popover_tooltip fp-help-popover"
          + (this.state.placeAbove ? " fp-arrow-below" : " fp-arrow-above"),
        role: "tooltip",
        style: this.state.style
      },
      h("div", {className: "slds-popover__body"}, this.props.text),
      h("span", {
        className: "fp-help-arrow",
        style: {left: this.state.arrowLeft + "px"}
      })
      )
      : null
    );
  }
}

function fieldLabel(label, helpText) {
  return h("label", {className: "slds-form-element__label"},
    label,
    helpText ? h(HelpIcon, {text: helpText}) : null
  );
}

// Plain native select — used for the small fixed "treat blank fields as" list.
function Combobox({label, value, placeholder, options, disabled, onChange, helpText}) {
  return h("div", {className: "slds-form-element"},
    fieldLabel(label, helpText),
    h("div", {className: "slds-form-element__control"},
      h("div", {className: "slds-select_container"},
        h("select", {
          className: "slds-select",
          value: value || "",
          disabled,
          onChange: e => onChange(e.target.value)
        },
        h("option", {value: ""}, placeholder),
        ...options.map(o => h("option", {key: o.value, value: o.value}, o.label))
        )
      )
    )
  );
}

// Searchable type-ahead picker (input + filtered dropdown), matching the
// Inspector's Field Creator pattern. `options` are {label, value}; on pick,
// calls onSelect(value). `displayValue` is the currently-selected label.
class Typeahead extends React.Component {
  constructor(props) {
    super(props);
    this.state = {search: "", open: false, activeIndex: -1};
    this.onInput = this.onInput.bind(this);
    this.onFocus = this.onFocus.bind(this);
    this.onBlur = this.onBlur.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
  }

  filtered() {
    const term = this.state.search.toLowerCase();
    const opts = this.props.options || [];
    if (!term) return opts.slice(0, 200);
    const score = str => {
      if (str === term) return 4;
      if (str.startsWith(term)) return 3;
      if (str.includes(term)) return 2;
      return 0;
    };
    return opts
      .filter(o => o.label.toLowerCase().includes(term) || o.value.toLowerCase().includes(term))
      .sort((a, b) => {
        const as = Math.max(score(a.label.toLowerCase()), score(a.value.toLowerCase()));
        const bs = Math.max(score(b.label.toLowerCase()), score(b.value.toLowerCase()));
        if (as !== bs) return bs - as;
        return a.label.localeCompare(b.label);
      })
      .slice(0, 200);
  }

  onInput(e) {
    this.setState({search: e.target.value, open: true, activeIndex: -1});
  }
  onFocus() {
    if (!this.props.disabled) this.setState({open: true});
  }
  onBlur() {
    // Delay so an option's onMouseDown/click registers before the list closes.
    setTimeout(() => this.setState({open: false, activeIndex: -1}), 150);
  }
  pick(opt) {
    this.setState({search: "", open: false, activeIndex: -1});
    this.props.onSelect(opt.value);
  }
  onKeyDown(e) {
    const list = this.filtered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.setState({open: true, activeIndex: Math.min(this.state.activeIndex + 1, list.length - 1)});
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.setState({activeIndex: Math.max(this.state.activeIndex - 1, 0)});
    } else if (e.key === "Enter") {
      if (this.state.open && list[this.state.activeIndex]) {
        e.preventDefault();
        this.pick(list[this.state.activeIndex]);
      }
    } else if (e.key === "Escape") {
      this.setState({open: false, activeIndex: -1});
    }
  }

  render() {
    const {label, placeholder, disabled, helpText, displayValue} = this.props;
    const list = this.state.open ? this.filtered() : [];
    // Show the selected label when closed and not actively searching.
    const inputValue = this.state.open ? this.state.search : (displayValue || "");
    return h("div", {className: "slds-form-element"},
      fieldLabel(label, helpText),
      h("div", {className: "slds-form-element__control fp-typeahead"},
        h("input", {
          type: "text",
          className: "slds-input fp-typeahead-input",
          placeholder,
          value: inputValue,
          disabled,
          autoComplete: "off",
          spellCheck: false,
          onChange: this.onInput,
          onFocus: this.onFocus,
          onBlur: this.onBlur,
          onKeyDown: this.onKeyDown
        }),
        this.state.open && list.length > 0
          ? h("ul", {className: "fp-typeahead-list"},
            ...list.map((o, i) => h("li", {
              key: o.value,
              className: "fp-typeahead-item" + (i === this.state.activeIndex ? " fp-active" : ""),
              // onMouseDown fires before input blur, so the pick isn't lost.
              onMouseDown: e => { e.preventDefault(); this.pick(o); }
            }, o.label))
          )
          : (this.state.open && (this.props.options || []).length > 0
            ? h("ul", {className: "fp-typeahead-list"},
              h("li", {className: "fp-typeahead-empty"}, "No matches"))
            : null)
      )
    );
  }
}

// Render a single token span, with hover behavior (function eval / field value /
// bracket-pair highlight) wired when the formula is evaluable.
function renderToken(token, lineIndex, model, canEval) {
  const isEvaluableFn = canEval && token.type === "function";
  const isHoverableField = canEval && token.type === "field" && model.hasFieldValue(token.text);
  const isBracket = token.type === "bracket" && token.bracketPairId != null;
  const hoverable = isEvaluableFn || isHoverableField;
  const isHighlighted = isBracket && model.hoveredBracketPairId === token.bracketPairId;
  return h("span", {
    key: token.id,
    className: token.cssClass + (hoverable ? " fp-evaluable" : "") + (isHighlighted ? " highlight-scope" : ""),
    "data-bracket-depth": token.colorDepth != null ? token.colorDepth : undefined,
    "data-bracket-pair-id": token.bracketPairId != null ? token.bracketPairId : undefined,
    "data-token-text": token.text,
    "data-token-type": token.type,
    onMouseEnter: (hoverable || isBracket)
      ? (e => {
        if (isEvaluableFn) model.onFunctionHover(e, lineIndex, token.text);
        else if (isHoverableField) model.onFieldHover(e, token.text);
        if (isBracket) model.highlightBracketPair(token.bracketPairId);
      })
      : undefined,
    onMouseLeave: (hoverable || isBracket)
      ? (() => {
        if (hoverable) model.hideTooltip();
        if (isBracket) model.clearBracketHighlight();
      })
      : undefined
  }, token.displayText);
}

// One syntax-highlighted line of formula output (gutter + tokens). Hovering a
// FUNCTION token evaluates its sub-expression, a FIELD token shows its value,
// and a BRACKET highlights its pair. Collapsible lines (IF/AND/OR/CASE) show a
// ▶/▼ toggle that collapses the nested block, exactly like the app.
function FormulaLine({line, lineIndex, model}) {
  const canEval = model && model.canEvaluateFormula;
  return h("div", {
    className: "formula-line-container",
    "data-hidden": line.isHidden ? "true" : undefined,
    "data-line-id": line.id
  },
  h("div", {className: "line-gutter", "data-line-id": line.id},
    h("span", {className: "line-number"}, line.lineNumber),
    h("span", {className: "gutter-arrow-space"},
      line.hasCollapseToggle
        ? h("span", {
          className: "gutter-collapse-toggle",
          "data-is-collapsed": line.isCollapsed ? "true" : "false",
          onClick: () => model.toggleCollapse(line.id, line.collapseDepth)
        }, line.isCollapsed ? "▶" : "▼")
        : null
    )
  ),
  h("div", {
    className: "formula-line",
    style: parseInlineStyle(line.indentStyle),
    "data-indent": line.indentLevel
  },
  // When collapsed, show only the tokens up to the first comma plus a "..."
  // preview (like the app); otherwise show all tokens.
  line.isCollapsed
    ? [
      ...line.tokens.filter(t => t.showWhenCollapsed).map(t => renderToken(t, lineIndex, model, canEval)),
      h("span", {key: "preview", className: "collapsed-preview"}, "...")
    ]
    : line.tokens.map(token => renderToken(token, lineIndex, model, canEval))
  )
  );
}

// Convert the engine's "padding-left: Nch; --indent-depth: N;" string into a
// React style object (React can't take a raw CSS string for `style`).
function parseInlineStyle(styleString) {
  const style = {};
  styleString.split(";").forEach(decl => {
    const idx = decl.indexOf(":");
    if (idx === -1) return;
    const prop = decl.slice(0, idx).trim();
    const val = decl.slice(idx + 1).trim();
    if (!prop) return;
    if (prop.startsWith("--")) {
      style[prop] = val;
    } else {
      // camelCase the CSS property for React
      const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      style[camel] = val;
    }
  });
  return style;
}

// Hover-result tooltip. Renders at the token, then remeasures and clamps so
// long HYPERLINK/IMAGE HTML never clips out of the iframe.
class FormulaTooltip extends React.Component {
  constructor(props) {
    super(props);
    this.state = {left: null, arrowLeft: 12, maxWidth: 480};
  }
  componentDidMount() {
    this.reposition();
  }
  componentDidUpdate(prevProps) {
    if (prevProps.tooltip !== this.props.tooltip) {
      this.reposition();
    }
  }
  reposition() {
    const el = this.refs.tip;
    const tip = this.props.tooltip;
    if (!el || !tip) return;
    const vw = window.innerWidth;
    const margin = 8;
    const maxWidth = Math.min(480, vw - 2 * margin);
    // Force max-width before measuring so wrapping is accounted for.
    el.style.maxWidth = maxWidth + "px";
    const width = Math.min(maxWidth, el.offsetWidth || maxWidth);
    let left = tip.anchorX - (width / 2);
    left = Math.max(margin, Math.min(left, vw - width - margin));
    const arrowLeft = Math.max(12, Math.min(tip.anchorX - left, width - 12));
    this.setState({left, arrowLeft, maxWidth});
  }
  render() {
    const tip = this.props.tooltip;
    const left = this.state.left != null ? this.state.left : Math.max(8, tip.anchorX - 40);
    const top = tip.placeAbove ? (tip.anchorTop - 5) : (tip.anchorBottom + 5);
    return h("div", {
      className: "formula-tooltip" + (tip.placeAbove ? " formula-tooltip-above" : " formula-tooltip-below"),
      ref: "tip",
      style: {
        position: "fixed",
        left: left + "px",
        top: top + "px",
        maxWidth: this.state.maxWidth + "px"
      }
    },
    tip.evaluating
      ? h("div", {className: "tooltip-sparkle-container"},
        h("span", {className: "glitter-sparkle"}, "✦"),
        h("span", {className: "glitter-sparkle"}, "✧"),
        h("span", {className: "glitter-sparkle"}, "✦"),
        h("span", {className: "glitter-sparkle"}, "✧"),
        h("span", {className: "glitter-sparkle"}, "✦"),
        h("span", {className: "glitter-sparkle"}, "✧"),
        h("span", {className: "glitter-sparkle"}, "✦"),
        h("span", {className: "glitter-sparkle"}, "✧")
      )
      : tip.content,
    h("span", {
      className: "formula-tooltip-arrow",
      style: {left: this.state.arrowLeft + "px"}
    })
    );
  }
}

class OutputSection extends React.Component {
  constructor(props) {
    super(props);
    this.state = {copied: false};
    this.onCopy = this.onCopy.bind(this);
  }
  async onCopy() {
    const ok = await this.props.model.copyPrettified();
    if (ok) {
      this.setState({copied: true});
      setTimeout(() => this.setState({copied: false}), 1500);
    }
  }
  render() {
    const model = this.props.model;
    return h("div", {className: "output-section"},
      h("div", {className: "output-header"},
        h("div", {className: "slds-text-heading_small", style: {paddingRight: "10px"}}, "Prettified Formula:"),
        h("div", {className: "header-actions"},
          // Result badge (only when this record/formula is evaluable).
          // HYPERLINK / IMAGE encodings are shown as the HTML Salesforce renders.
          model.showResultBadge
            ? h("div", {className: "formula-result-badge"},
              [
                h("span", {key: "l", className: "result-label"}, "Result:"),
                h("span", {
                  key: "v",
                  className: "result-value" + (model.displayFormulaResult !== model.formulaResult ? " result-value-markup" : ""),
                  title: model.displayFormulaResult
                }, model.displayFormulaResult)
              ],
              h(HelpIcon, {key: "help", text: model.resultHelpText})
            )
            : null,
          h("div", {className: "copy-button-container"},
            h("button", {
              className: "copy-button slds-button slds-button_icon slds-button_icon-border-filled",
              title: "Copy formatted formula",
              onClick: this.onCopy
            }, icon("copy")),
            this.state.copied ? h("span", {className: "copied-tooltip"}, "Copied!") : null
          ),
          h("button", {
            className: "refresh-button slds-button slds-button_icon slds-button_icon-border-filled",
            title: "Refresh",
            disabled: model.refreshButtonDisabled,
            onClick: () => model.refresh()
          }, icon("refresh"))
        )
      ),
      h("div", {className: "formula-output"},
        ...model.formattedLines.map(line => h(FormulaLine, {key: line.id, line, lineIndex: line.id, model}))
      ),
      // On-hover tooltip: a field's value, or a function sub-expression result
      // (with the app's glittering sparkle animation while evaluating).
      model.tooltip
        ? h(FormulaTooltip, {key: model.tooltip.tokenId + (model.tooltip.evaluating ? "-e" : ""), tooltip: model.tooltip})
        : null
    );
  }
}

class App extends React.Component {
  constructor(props) {
    super(props);
    this.model = props.model;
  }
  componentDidMount() {
    if (this.model.isSelectMode) {
      this.model.loadObjects();
    }
    // Pre-check the Author-Apex permission so the evaluation UI gates correctly.
    this.model.checkApexPermission();
  }
  render() {
    const model = this.model;
    return h("div", {className: "fp-body slds-p-around_medium"},
      model.errorMessage
        ? h("div", {className: "slds-notify slds-notify_alert slds-alert_error slds-m-bottom_small", role: "alert"},
          model.errorMessage)
        : null,

      model.infoMessage
        ? h("div", {className: "slds-notify slds-notify_alert slds-alert_offline slds-m-bottom_small", role: "status"},
          model.infoMessage)
        : null,

      h(ModeToggle, {model,
        onSelect: mode => {
          model.setInputMode(mode);
          if (mode === INPUT_MODE.SELECT) model.loadObjects();
        }}),

      // Paste mode
      model.isPasteMode ? h("div", {className: "slds-m-bottom_medium"},
        h("textarea", {
          className: "large-textarea slds-textarea",
          value: model.pastedRawFormula,
          placeholder: "Paste your formula here...",
          onChange: e => model.onPasteFormulaChange(e.target.value)
        }),
        h("div", {className: "slds-m-top_small slds-size_1-of-3"},
          h(Combobox, {
            label: "Treat blank fields as",
            value: model.pasteModeBlankFieldHandling,
            placeholder: "Choose blank field handling",
            options: BLANK_FIELD_OPTIONS,
            disabled: model.noPastedFormula,
            helpText: HELP_BLANK,
            onChange: v => { model.pasteModeBlankFieldHandling = v; model.didUpdate(); }
          })
        )
      ) : null,

      // Select mode
      model.isSelectMode ? (
        model.isLoadingObjects
          ? h(SparkleLoader, {title: "Loading your objects..."})
          : h("div", {className: "slds-grid slds-wrap slds-gutters slds-m-bottom_medium"},
            h("div", {className: "slds-col slds-size_1-of-3"},
              h(Typeahead, {
                label: "Object",
                displayValue: model.selectedObjectLabel,
                placeholder: "Search and select an object...",
                options: model.objectOptions,
                disabled: model.objectOptions.length === 0,
                helpText: HELP_OBJECT,
                onSelect: v => model.onSelectObject(v)
              })
            ),
            h("div", {className: "slds-col slds-size_1-of-3"},
              h(Typeahead, {
                label: "Field",
                displayValue: model.selectedFieldLabel,
                placeholder: model.isLoadingFields ? "Loading formula fields..." : "Search and select a formula field...",
                options: model.fieldOptions,
                disabled: !model.selectedObject || model.isLoadingFields,
                helpText: HELP_FIELD,
                onSelect: v => model.onSelectField(v)
              })
            ),
            h("div", {className: "slds-col slds-size_1-of-3"},
              h("div", {className: "field-with-button"},
                h("div", {className: "field-combobox-wrapper"},
                  h(Combobox, {
                    label: "Treat blank fields as",
                    value: model.selectModeBlankFieldHandling,
                    placeholder: "Choose blank field handling",
                    options: BLANK_FIELD_OPTIONS,
                    disabled: model.noFieldSelected,
                    helpText: HELP_BLANK,
                    onChange: v => { model.selectModeBlankFieldHandling = v; model.didUpdate(); }
                  })
                ),
                h("button", {
                  className: "setup-button slds-button slds-button_icon slds-button_icon-border-filled",
                  title: "Open field in Setup",
                  disabled: model.noFieldSelected,
                  onClick: () => model.openFieldInSetup()
                }, icon("setup"))
              )
            )
          )
      ) : null,

      // Prettify button (paste mode, before output)
      model.showPrettifyButton ? h("div", {className: "slds-m-top_small slds-m-bottom_medium slds-align_absolute-center"},
        h("div", {className: "prettify-button-wrapper"},
          h("button", {
            className: "custom-brand-button slds-button slds-button_brand",
            onClick: () => model.runPrettify()
          }, "✨ Prettify ✨"),
          h("span", {className: "button-shine"})
        )
      ) : null,

      // Sparkle loader while a field's formula is fetched/prettified, while an
      // object's formula fields are loading, or while the formula is being
      // evaluated — like the app, the prettified output stays hidden until the
      // result is ready.
      (model.isLoading || model.isLoadingFields || model.isEvaluatingFullFormula)
        ? h(SparkleLoader, {title: model.isLoadingFields ? "Loading formula fields..." : null})
        : null,

      model.showOutputSection ? h(OutputSection, {model}) : null
    );
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
{
  let args = new URLSearchParams(location.search.slice(1));
  let sfHost = args.get("host");
  let contextObject = args.get("object");
  let contextRecordId = args.get("recordId");
  sfConn.getSession(sfHost).then(() => {
    let root = document.getElementById("root");
    let model = new Model(sfHost, contextObject, contextRecordId);
    model.reactCallback = () => {
      ReactDOM.render(h(App, {model}), root);
    };
    ReactDOM.render(h(App, {model}), root);
  }).catch(err => {
    let root = document.getElementById("root");
    root.textContent = "Formula Prettifier could not connect to Salesforce: " + (err.message || err);
    console.error("Formula Prettifier: getSession failed", err);
  });
}