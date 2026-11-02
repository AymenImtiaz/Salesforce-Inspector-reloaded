/* global React */
/* Formula Prettifier panel — the prettified-formula view used inside an SLDS
 * modal on the Show All Data (Inspect) page.
 *
 * It renders a formula prettified (indentation, syntax highlighting, rainbow
 * brackets, collapsible IF/AND/OR/CASE blocks) and, when the formula can be
 * evaluated against the current record, shows a live "Result" and lets the user
 * hover a field to see its value or a function to evaluate its sub-expression.
 *
 * Opens in VIEW mode on the given field's formula; a pencil toggles inline EDIT
 * so the user can tweak the formula and re-prettify / re-evaluate on the spot.
 * Edit is a TEMPORARY scratchpad — it never writes the formula back to the field.
 *
 * The formatting/tokenizing engine is formula-prettifier-core.js; evaluation
 * (anonymous Apex via sfConn) is formula-prettifier-eval.js. This component runs
 * inline on the Inspect page (same React tree), so there is no iframe.
 */
import {prettify, FORMULA_FUNCTIONS, extractFunctionExpression} from "../formula-prettifier-core.js";
import {fetchFieldData, evaluateExpression, replaceFieldsWithValues, isResultHyperlink, isResultImage, parseHyperlink, imageEncodingToHtml, canRunApex, UNABLE_TO_EVALUATE} from "../formula-prettifier-eval.js";

const h = React.createElement;

// --- SLDS icon from symbols.svg ------------------------------------------------
function icon(name, sizeClass = "slds-icon_x-small") {
  return h("svg", {
    className: "fp-icon " + sizeClass,
    "aria-hidden": "true",
    style: {fill: "currentColor", pointerEvents: "none"}
  },
  h("use", {xlinkHref: "symbols.svg#" + name})
  );
}

// Collapse pretty-print whitespace (newlines, indentation, cosmetic spaces added
// for display) back into a clean single-line formula suitable for evaluation,
// WITHOUT touching whitespace inside string literals ("..." / '...'). Used when
// applying an edit: the editor shows the pretty form, but the engine must eval a
// normalized formula.
function normalizeFormula(text) {
  if (!text) return "";
  let out = "";
  let inStr = false;
  let quote = "";
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      // A backslash escapes the next char (e.g. \" is a literal quote, which
      // Salesforce formula syntax permits) — consume both so an escaped quote
      // doesn't look like the closing quote (keeps us consistent with the core
      // tokenizer's escape-aware string handling).
      if (ch === "\\" && i + 1 < text.length) {
        out += ch + text[i + 1];
        i++;
        continue;
      }
      out += ch;
      if (ch === quote) { inStr = false; quote = ""; }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      if (pendingSpace) { out += " "; pendingSpace = false; }
      inStr = true; quote = ch; out += ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      // Defer whitespace; emit a single space only if real content follows.
      if (out.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) { out += " "; pendingSpace = false; }
    out += ch;
  }
  return out.trim();
}

// Convert the engine's "padding-left: Nch;" string into a React style object.
function parseInlineStyle(styleString) {
  const style = {};
  styleString.split(";").forEach(decl => {
    const idx = decl.indexOf(":");
    if (idx === -1) return;
    const prop = decl.slice(0, idx).trim();
    const val = decl.slice(idx + 1).trim();
    if (!prop) return;
    const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    style[camel] = val;
  });
  return style;
}

// Highlight raw text for the edit-mode overlay WITHOUT reformatting: every
// character (including whitespace and newlines) is preserved so the colored
// layer aligns exactly with the textarea underneath it. Splits on the same
// delimiters as the tokenizer, then classifies each part like createToken.
const HL_SPLIT = /(\s+|[(,)]|==|!=|<=|>=|<>|&&|\|\||\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|[+\-*/^<>=&|]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
const FP_FUNCTIONS_UPPER = new Set(FORMULA_FUNCTIONS.map(f => f.toUpperCase()));
function classifyPart(part) {
  if (/^\s+$/.test(part)) return null; // whitespace: no color
  if (/^\/\*.*\*\/$/.test(part)) return "comment";
  if (FP_FUNCTIONS_UPPER.has(part.toUpperCase())) return "function"; // case-insensitive
  if (/^"(?:\\.|[^"\\])*"$/.test(part) || /^'(?:\\.|[^'\\])*'$/.test(part)) return "string";
  if (/^\d+\.?\d*$/.test(part)) return "number";
  if (/^(NULL|TRUE|FALSE)$/i.test(part)) return "number";
  if (/^\$?[A-Za-z_][a-zA-Z0-9_]*(__[cr])?$/.test(part)
      || /^\$?[A-Za-z_][a-zA-Z0-9_]*[:.][a-zA-Z0-9_.:]+/.test(part)) return "field";
  if (/^(==|!=|<=|>=|<>|&&|\|\||[+\-*/^<>=&|])$/.test(part)) return "operator";
  if (part === "(" || part === ")") return "bracket";
  return null;
}
function highlightLine(line, keyPrefix) {
  const parts = line.split(HL_SPLIT).filter(p => p !== "" && p != null);
  return parts.map((part, i) => {
    const type = classifyPart(part);
    return type
      ? h("span", {key: keyPrefix + "-" + i, className: "token-" + type}, part)
      : part;
  });
}

// One token span, with hover behavior wired when the formula is evaluable.
function renderToken(token, lineIndex, panel, canEval) {
  const isEvaluableFn = canEval && token.type === "function";
  // Field tokens are hoverable whenever evaluation is possible — NOT gated on
  // the value being loaded yet — so hovering during the initial fetch shows a
  // sparkle and then the value the moment it arrives (no dead first hover).
  const isHoverableField = canEval && token.type === "field";
  const isBracket = token.type === "bracket" && token.bracketPairId != null;
  const hoverable = isEvaluableFn || isHoverableField;
  const isHighlighted = isBracket && panel.state.hoveredBracketPairId === token.bracketPairId;
  return h("span", {
    key: token.id,
    className: token.cssClass + (hoverable ? " fp-evaluable" : "") + (isHighlighted ? " highlight-scope" : ""),
    "data-bracket-depth": token.colorDepth != null ? token.colorDepth : undefined,
    "data-bracket-pair-id": token.bracketPairId != null ? token.bracketPairId : undefined,
    "data-token-text": token.text,
    "data-token-type": token.type,
    onMouseEnter: (hoverable || isBracket)
      ? (e => {
        if (isEvaluableFn) panel.onFunctionHover(e, lineIndex, token.text);
        else if (isHoverableField) panel.onFieldHover(e, token.text);
        if (isBracket) panel.setHoveredBracket(token.bracketPairId);
      })
      : undefined,
    onMouseLeave: (hoverable || isBracket)
      ? (() => {
        if (hoverable) panel.hideTooltip();
        if (isBracket) panel.setHoveredBracket(null);
      })
      : undefined
  }, token.displayText);
}

// Hover-result tooltip. Renders at the token, then remeasures and clamps so it
// never clips, with a custom arrow pointing at the token. (Same behavior as the
// standalone prettifier's FormulaTooltip.)
class FormulaTooltip extends React.Component {
  constructor(props) {
    super(props);
    this.state = {left: null, top: null, arrowLeft: 12, maxWidth: 480};
  }
  componentDidMount() { this.reposition(); }
  componentDidUpdate(prevProps) {
    if (prevProps.tooltip !== this.props.tooltip) this.reposition();
  }
  reposition() {
    const el = this.refs.tip;
    const tip = this.props.tooltip;
    if (!el || !tip) return;
    const vw = window.innerWidth;
    const margin = 8;
    const maxWidth = Math.min(480, vw - (2 * margin));
    el.style.maxWidth = maxWidth + "px";
    const width = Math.min(maxWidth, el.offsetWidth || maxWidth);

    // anchor* are VIEWPORT coords (getBoundingClientRect). But a position:fixed
    // element is positioned relative to its containing block, which is the
    // nearest ancestor with a transform (SLDS modals set transform on
    // .slds-modal / .slds-modal__container) — NOT the viewport. So subtract that
    // containing block's viewport offset. offsetParent resolves to it.
    let originLeft = 0;
    let originTop = 0;
    const cb = el.offsetParent;
    if (cb && cb.getBoundingClientRect) {
      const cbRect = cb.getBoundingClientRect();
      originLeft = cbRect.left;
      originTop = cbRect.top;
    }

    let vpLeft = tip.anchorX - (width / 2);
    vpLeft = Math.max(margin, Math.min(vpLeft, vw - width - margin));
    const vpTop = tip.placeAbove ? (tip.anchorTop - 5) : (tip.anchorBottom + 5);
    const arrowLeft = Math.max(12, Math.min(tip.anchorX - vpLeft, width - 12));

    this.setState({left: vpLeft - originLeft, top: vpTop - originTop, arrowLeft, maxWidth});
  }
  render() {
    const tip = this.props.tooltip;
    // Fall back to viewport coords until reposition() measures the container.
    const left = this.state.left != null ? this.state.left : Math.max(8, tip.anchorX - 40);
    const top = this.state.top != null ? this.state.top : (tip.placeAbove ? (tip.anchorTop - 5) : (tip.anchorBottom + 5));
    return h("div", {
      className: "formula-tooltip" + (tip.placeAbove ? " formula-tooltip-above" : " formula-tooltip-below"),
      ref: "tip",
      style: {position: "fixed", left: left + "px", top: top + "px", maxWidth: this.state.maxWidth + "px"}
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
    h("span", {className: "formula-tooltip-arrow", style: {left: this.state.arrowLeft + "px"}})
    );
  }
}

export default class FormulaPrettifierPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      rawFormula: props.formula || "",
      editing: false,
      editText: "",
      lines: [], // render model from prettify()
      prettified: "",
      // evaluation
      apexAllowed: null,
      isEvaluating: false,
      formulaResult: "",
      fieldValues: null,
      fieldTypes: null,
      // hover
      tooltip: null, // {content, x, y, evaluating, tokenId}
      hoveredBracketPairId: null,
      // header actions
      copiedTooltipVisible: false
    };
    this._copiedTimer = null;
    // Monotonic token so overlapping evaluations (e.g. Refresh/Apply clicked
    // while an earlier evaluation is still in flight) can't resolve out of order
    // and overwrite the newest result with a stale one.
    this._evalRun = 0;
    this._mounted = false;
  }

  componentWillUnmount() {
    this._mounted = false;
    if (this._copiedTimer) clearTimeout(this._copiedTimer);
  }

  componentDidMount() {
    this._mounted = true;
    this.prettifyAndEvaluate(this.state.rawFormula);
    canRunApex().then(allowed => { if (this._mounted) this.setState({apexAllowed: allowed}); });
  }

  // --- prettify + evaluate ----------------------------------------------------
  prettifyAndEvaluate(raw) {
    if (!raw || !raw.trim()) {
      this.setState({lines: [], prettified: "", formulaResult: ""});
      return;
    }
    const {prettified, lines} = prettify(raw, FORMULA_FUNCTIONS);
    this.setState({prettified, lines}, () => this.startEvaluation(raw));
  }

  get canEvaluate() {
    return this.state.apexAllowed !== false
      && !!this.props.recordId
      && !!this.props.objectApiName;
  }

  async startEvaluation(rawFormula) {
    // Claim this run; any state write below only applies if it's still the latest
    // (guards against an earlier, slower evaluation overwriting a newer result).
    const run = ++this._evalRun;
    const current = () => this._mounted && this._evalRun === run;
    const setIfCurrent = (patch) => { if (current()) this.setState(patch); };

    setIfCurrent({formulaResult: "", fieldValues: null, fieldTypes: null});
    if (this.state.apexAllowed === null) {
      const allowed = await canRunApex();
      setIfCurrent({apexAllowed: allowed});
    }
    if (!this.canEvaluate) return;

    setIfCurrent({isEvaluating: true});
    // Phase 1: fetch field values/types. Exposed as a promise so a field hover
    // that happens before it resolves can await it (and show a sparkle mean-
    // while). Set fieldValues as soon as phase 1 is done — before the slower
    // phase-2 result evaluation — so fields become hoverable right away.
    this.fieldDataPromise = fetchFieldData(rawFormula, this.props.objectApiName, this.props.recordId)
      .then(data => {
        setIfCurrent({fieldValues: data.fieldValues, fieldTypes: data.fieldTypes});
        return data;
      });
    try {
      const data = await this.fieldDataPromise;
      const expression = replaceFieldsWithValues(rawFormula, data.fieldValues, data.fieldTypes);
      const result = await evaluateExpression({
        expression,
        objectApiName: this.props.objectApiName,
        recordId: this.props.recordId,
        blankFieldHandling: "BlankAsZero",
        fieldDataType: this.props.fieldDataType || ""
      });
      setIfCurrent({formulaResult: result});
    } catch (e) {
      console.error("Formula Prettifier: evaluation failed", e);
      setIfCurrent({formulaResult: UNABLE_TO_EVALUATE});
    } finally {
      setIfCurrent({isEvaluating: false});
    }
  }

  // --- edit mode --------------------------------------------------------------
  // Edit within the prettified view: the textarea holds the already-formatted
  // text (so what you edit looks like the pretty output), and a highlighted
  // layer behind it re-colors live as you type. Applying re-prettifies+evaluates.
  // This is a TEMPORARY scratchpad — it never saves the formula back to the field.
  enterEdit() {
    // Seed the editor with the SAME text the view shows — reconstructed from the
    // render model's displayText (which carries the intra-paren / post-comma
    // spacing) — so toggling into edit mode doesn't reflow the formula. Fall back
    // to the formatter output / raw formula if the model isn't available.
    const editText = this.displayTextFromLines() || this.state.prettified || this.state.rawFormula;
    this.setState({editing: true, editText});
  }
  // Rebuild the on-screen (display) text from the prettified render model, so the
  // editor shows exactly what view mode shows (spacing included).
  displayTextFromLines() {
    const lines = this.state.lines;
    if (!lines || !lines.length) return "";
    return lines.map(line => {
      const indent = " ".repeat(Math.max(0, line.indentLevel || 0) * 4);
      const text = (line.tokens || [])
        .map(t => (t.displayText != null ? t.displayText : t.text))
        .join("")
        .replace(/\u200B/g, ""); // strip zero-width spacers used for layout
      return indent + text;
    }).join("\n");
  }
  onEditChange(value) {
    this.setState({editText: value});
  }
  applyEdit() {
    // The editor holds the PRETTY (multi-line, indented, cosmetically-spaced)
    // text. Evaluation must run against a normalized single-line formula — the
    // same shape the field's original formula had — otherwise the pretty-print
    // whitespace makes the Apex evaluation fail ("Unable to evaluate"). prettify()
    // re-formats it for display; we keep the normalized form as rawFormula so any
    // later refresh/eval also uses the clean version.
    const normalized = normalizeFormula(this.state.editText);
    this.setState({editing: false, rawFormula: normalized});
    this.prettifyAndEvaluate(normalized);
  }
  syncEditScroll() {
    // Keep the highlight layer + line-number gutter scrolled in lock-step with
    // the textarea.
    const ta = this.refs.editTextarea;
    const layer = this.refs.editHighlight;
    const gutter = this.refs.editGutter;
    if (ta && layer) {
      layer.scrollTop = ta.scrollTop;
      layer.scrollLeft = ta.scrollLeft;
    }
    if (ta && gutter) {
      gutter.scrollTop = ta.scrollTop;
    }
  }

  // --- header actions: copy / refresh -----------------------------------------
  // Copy the prettified formula (the user's selection if any, else the whole
  // formatted text), then flash a "Copied!" tooltip. Matches the app's handleCopy.
  handleCopy() {
    let text;
    const selection = window.getSelection && window.getSelection();
    if (selection && selection.rangeCount > 0 && selection.toString().trim()) {
      text = selection.toString();
    } else {
      text = this.state.prettified || this.state.rawFormula;
    }
    if (!text) return;
    const flash = () => {
      if (this._copiedTimer) clearTimeout(this._copiedTimer);
      this.setState({copiedTooltipVisible: true});
      this._copiedTimer = setTimeout(() => this.setState({copiedTooltipVisible: false}), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => flash());
    } else {
      flash();
    }
  }
  // Re-prettify and re-evaluate the current formula from scratch.
  handleRefresh() {
    this.prettifyAndEvaluate(this.state.rawFormula);
  }

  // --- collapse / expand (ported from the app) --------------------------------
  toggleCollapse(lineId, collapseDepth) {
    const lines = this.state.lines;
    const targetLine = lines[lineId];
    if (!targetLine) return;
    targetLine.isCollapsed = !targetLine.isCollapsed;
    targetLine.collapsedDepth = collapseDepth;
    const closingLineId = this.findClosingLine(lineId, collapseDepth);
    if (closingLineId !== null) {
      this.updateLineVisibility(lineId, closingLineId, targetLine.isCollapsed);
      lines[closingLineId].isHidden = false;
    }
    this.setState({lines: [...lines]});
  }
  findClosingLine(lineId, collapseDepth) {
    const lines = this.state.lines;
    let depthCounter = 1;
    for (let i = lineId + 1; i < lines.length; i++) {
      for (const token of lines[i].tokens) {
        if (token.type === "bracket" && token.bracketDepth === collapseDepth) {
          if (token.text === "(") depthCounter++;
          else if (token.text === ")") { depthCounter--; if (depthCounter === 0) return i; }
        }
      }
    }
    return null;
  }
  updateLineVisibility(startLine, endLine, isCollapsing) {
    const lines = this.state.lines;
    for (let i = startLine + 1; i < endLine; i++) {
      lines[i].isHidden = isCollapsing ? true : this.isLineInCollapsedBlock(i);
    }
  }
  isLineInCollapsedBlock(lineId) {
    const lines = this.state.lines;
    for (let j = 0; j < lineId; j++) {
      const line = lines[j];
      if (line.isCollapsed && line.collapsedDepth !== undefined) {
        const closingLineId = this.findClosingLine(j, line.collapsedDepth);
        if (closingLineId !== null && lineId > j && lineId < closingLineId) return true;
      }
    }
    return false;
  }

  // --- hover (field value / function eval / bracket highlight) -----------------
  hasFieldValue(fieldText) {
    return !!this.state.fieldValues && Object.prototype.hasOwnProperty.call(this.state.fieldValues, fieldText);
  }
  // Position a tooltip anchored to the hovered token (above if there's room,
  // else below); the FormulaTooltip component clamps + points its arrow at it.
  showTooltip(anchor, content, tokenId, evaluating) {
    const rect = anchor.getBoundingClientRect();
    const placeAbove = rect.top >= 48;
    this.setState({tooltip: {
      content,
      anchorX: rect.left + (rect.width / 2),
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      placeAbove,
      evaluating: !!evaluating,
      tokenId
    }});
  }
  onFieldHover(event, fieldText) {
    if (!this.canEvaluate) return;
    const anchor = event.target;
    const tokenId = "field-" + fieldText;
    // Values already loaded → show the value immediately.
    if (this.hasFieldValue(fieldText)) {
      const value = this.state.fieldValues[fieldText];
      if (value === undefined) return;
      this.showTooltip(anchor, value === null ? "null" : String(value), tokenId, false);
      return;
    }
    // Values still loading → show a sparkle, then the value once phase 1 resolves
    // (only if the user is still hovering this same field).
    if (this.fieldDataPromise) {
      this.showTooltip(anchor, "", tokenId, true);
      this.fieldDataPromise.then(() => {
        if (!this.state.tooltip || this.state.tooltip.tokenId !== tokenId) return;
        if (!this.hasFieldValue(fieldText)) { this.hideTooltip(); return; }
        const value = this.state.fieldValues[fieldText];
        this.showTooltip(anchor, value === null ? "null" : String(value), tokenId, false);
      });
    }
  }
  onFunctionHover(event, lineIndex, functionName) {
    if (!this.canEvaluate || !this.state.fieldValues) return;
    const subExpression = extractFunctionExpression(this.state.lines, lineIndex, functionName);
    if (!subExpression) return;
    const tokenId = lineIndex + "-function-" + functionName;
    this.evaluateSubExpression(event.target, subExpression, tokenId);
  }
  async evaluateSubExpression(anchor, subExpression, tokenId) {
    if (!this.canEvaluate || !this.state.fieldValues) return;
    this.showTooltip(anchor, "", tokenId, true);
    try {
      const expression = replaceFieldsWithValues(subExpression, this.state.fieldValues, this.state.fieldTypes);
      const result = await evaluateExpression({
        expression,
        objectApiName: this.props.objectApiName,
        recordId: this.props.recordId,
        blankFieldHandling: "BlankAsZero",
        fieldDataType: ""
      });
      if (this.state.tooltip && this.state.tooltip.tokenId === tokenId) {
        // Render HYPERLINK/IMAGE results as real elements (same as the Result
        // badge), not the raw HTML string formatEncodedFormulaResult returns.
        this.showTooltip(anchor, this.renderResultValue(result), tokenId, false);
      }
    } catch {
      if (this.state.tooltip && this.state.tooltip.tokenId === tokenId) {
        this.showTooltip(anchor, UNABLE_TO_EVALUATE, tokenId, false);
      }
    }
  }
  hideTooltip() {
    if (this.state.tooltip) this.setState({tooltip: null});
  }
  setHoveredBracket(pairId) {
    if (this.state.hoveredBracketPairId !== pairId) this.setState({hoveredBracketPairId: pairId});
  }

  // --- render -----------------------------------------------------------------
  renderResultBadge() {
    if (this.state.isEvaluating) {
      return h("div", {className: "formula-result-badge"},
        h("span", {className: "result-loading"}, "Evaluating..."));
    }
    const result = this.state.formulaResult;
    if (result === "") return null;
    return h("div", {className: "formula-result-badge"},
      h("span", {className: "result-label"}, "Result:"),
      this.renderResultValue(result)
    );
  }

  // Render the evaluated result as a real element (matches the app): a clickable
  // anchor for HYPERLINK, an <img> for IMAGE, otherwise a plain span. Never inject
  // raw Apex output as HTML.
  renderResultValue(result) {
    if (isResultHyperlink(result)) {
      const parsed = parseHyperlink(result);
      if (parsed) {
        // A HYPERLINK label may itself be an IMAGE encoding.
        if (parsed.label && parsed.label.indexOf("_IM1_") !== -1) {
          const img = this.renderImage(parsed.label);
          if (img) {
            return h("a", {href: parsed.url, target: parsed.target || "_blank", rel: "noopener noreferrer", className: "result-hyperlink", title: parsed.url}, img);
          }
        }
        return h("a", {href: parsed.url, target: parsed.target || "_blank", rel: "noopener noreferrer", className: "result-hyperlink", title: parsed.url}, parsed.label || parsed.url);
      }
    }
    if (isResultImage(result)) {
      const img = this.renderImage(result);
      if (img) return img;
    }
    return h("span", {className: "result-value", title: String(result)}, result);
  }

  // Build an <img> from an IMAGE encoding by parsing the HTML the eval layer
  // produces (attributes only — no scripting), so nothing is injected as markup.
  renderImage(encoded) {
    const html = imageEncodingToHtml(encoded);
    if (!html) return null;
    const src = (html.match(/src="([^"]*)"/) || [])[1] || "";
    const alt = (html.match(/alt="([^"]*)"/) || [])[1] || "";
    const height = (html.match(/height="([^"]*)"/) || [])[1];
    const width = (html.match(/width="([^"]*)"/) || [])[1];
    if (!src) return null;
    const props = {src, alt, className: "result-image", border: "0"};
    if (height) props.height = height;
    if (width) props.width = width;
    return h("img", props);
  }

  renderLine(line) {
    const canEval = this.canEvaluate;
    return h("div", {
      key: line.id,
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
            onClick: () => this.toggleCollapse(line.id, line.collapseDepth)
          }, line.isCollapsed ? "▶" : "▼")
          : null
      )
    ),
    h("div", {className: "formula-line", style: parseInlineStyle(line.indentStyle), "data-indent": line.indentLevel},
      line.isCollapsed
        ? [
          ...line.tokens.filter(t => t.showWhenCollapsed).map(t => renderToken(t, line.id, this, canEval)),
          h("span", {key: "preview", className: "collapsed-preview"}, "...")
        ]
        : line.tokens.map(token => renderToken(token, line.id, this, canEval))
    )
    );
  }

  // Edit mode: an "input editor" — a textarea with transparent text sitting on
  // top of a syntax-highlighted layer showing the same characters. The user
  // edits real text (reliable caret/selection/undo) but sees the colored,
  // formatted view, live as they type.
  renderEditor() {
    const text = this.state.editText;
    const editLines = text.split("\n");
    return h("div", {className: "fp-editor"},
      // Line-number gutter, kept visually consistent with view mode (matches
      // .line-gutter width) and scroll-synced with the textarea.
      h("div", {className: "fp-editor-gutter", ref: "editGutter", "aria-hidden": "true"},
        editLines.map((line, i) =>
          h("div", {key: i, className: "fp-editor-gutter-num"}, i + 1)
        )
      ),
      h("div", {className: "fp-editor-body"},
        h("div", {className: "fp-editor-highlight", ref: "editHighlight", "aria-hidden": "true"},
          editLines.map((line, i) =>
            h("div", {key: i, className: "fp-editor-line"},
              line ? highlightLine(line, i) : "\u200B" // keep empty lines tall
            )
          )
        ),
        h("textarea", {
          className: "fp-editor-textarea",
          ref: "editTextarea",
          value: text,
          spellCheck: false,
          autoFocus: true,
          wrap: "off",
          onChange: e => this.onEditChange(e.target.value),
          onScroll: () => this.syncEditScroll(),
          placeholder: "Edit the formula..."
        })
      )
    );
  }

  // Header toolbar: Copy (+ "Copied!" flash), Refresh, and the Edit/Apply pencil.
  renderHeaderActions() {
    const {editing, copiedTooltipVisible} = this.state;
    const hasFormula = this.state.lines.length > 0 || !!this.state.rawFormula;
    return h("div", {className: "header-actions"},
      this.renderResultBadge(),
      // Copy
      h("div", {className: "copy-button-container"},
        h("button", {
          className: "copy-button slds-button slds-button_icon slds-button_icon-border-filled",
          title: "Copy formatted formula",
          disabled: !hasFormula || editing,
          onClick: () => this.handleCopy()
        }, icon("copy")),
        copiedTooltipVisible ? h("span", {className: "copied-tooltip"}, "Copied!") : null
      ),
      // Refresh
      h("button", {
        className: "refresh-button slds-button slds-button_icon slds-button_icon-border-filled",
        title: "Refresh",
        disabled: !hasFormula || editing,
        onClick: () => this.handleRefresh()
      }, icon("refresh")),
      // Edit / Apply. This is a temporary scratchpad — it re-prettifies and
      // re-evaluates the edited text against this record; it does NOT save the
      // formula back to the field (that's a Setup/metadata change).
      h("button", {
        className: "fp-edit-button slds-button slds-button_icon slds-button_icon-border-filled" + (editing ? " fp-edit-button_active" : ""),
        title: editing ? "Apply — re-evaluate (does not save to the field)" : "Try edits — evaluate a modified formula (does not save to the field)",
        onClick: () => (editing ? this.applyEdit() : this.enterEdit())
      }, icon(editing ? "check" : "edit"))
    );
  }

  render() {
    const {editing, lines, tooltip} = this.state;
    return h("div", {className: "fp-panel"},
      h("div", {className: "output-section"},
        // Header: "Prettified Formula" heading (left) + actions (right).
        h("div", {className: "output-header"},
          h("div", {className: "output-title"},
            icon("sparkles", "slds-icon_x-small"),
            h("span", {className: "slds-text-heading_small"}, "Prettified Formula")
          ),
          this.renderHeaderActions()
        ),

        editing
          ? [
            // Make the scope of "edit" explicit: this is a temporary evaluation
            // scratchpad, not a way to change the field's definition.
            h("div", {key: "note", className: "fp-edit-note"},
              icon("info", "slds-icon_xx-small"),
              h("span", {}, "Temporary scratchpad — try changes and re-evaluate against this record. This does not save the formula to the field.")
            ),
            h("div", {key: "editor"}, this.renderEditor())
          ]
          : h("div", {className: "formula-output"},
            lines.length > 0
              ? lines.map(line => this.renderLine(line))
              : h("div", {className: "slds-p-around_small slds-text-color_weak"}, "No formula to display.")
          )
      ),

      // Hover tooltip (field value / sub-expression result).
      tooltip ? h(FormulaTooltip, {tooltip}) : null
    );
  }
}
