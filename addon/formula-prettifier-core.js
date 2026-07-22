/* Formula Prettifier — core engine (framework-free)
 *
 * Faithful port of the pure-JS heart of the Salesforce Formula Prettifier LWC:
 * the formatting (indentation / line-breaking) algorithm and the tokenizer /
 * syntax-highlighter. This module has NO dependency on LWC, React, the DOM, or
 * Salesforce APIs — it turns a raw formula string into (a) a prettified plain
 * string and (b) a render model of lines + classified tokens.
 *
 * Ported from prettifier/force-app/main/default/lwc/formulaPrettifier/formulaPrettifier.js
 * and prettifier/force-app/main/default/classes/PrettifierConstants.cls.
 */

// The canonical list of Salesforce formula function names used to classify
// FUNCTION tokens. Mirrors PrettifierConstants.FORMULA_FUNCTIONS (TRUE/FALSE/NULL
// are intentionally included so they are not mistaken for field references).
export const FORMULA_FUNCTIONS = [
  "ACOS", "ADDMONTHS", "AND", "ASCII", "ASIN", "ATAN", "ATAN2", "BEGINS", "BLANKVALUE",
  "BR", "CASE", "CASESAFEID", "CEILING", "CHR", "CONTAINS", "COS", "CURRENCYRATE",
  "DATE", "DATETIMEVALUE", "DATEVALUE", "DAY", "DAYOFYEAR", "DISTANCE", "EXP", "FIND",
  "FLOOR", "FORMATDURATION", "FROMUNIXTIME", "GEOLOCATION", "GETSESSIONID", "HOUR",
  "HYPERLINK", "IF", "IMAGE", "INCLUDES", "INITCAP", "ISBLANK", "ISNULL", "ISNUMBER",
  "ISOWEEK", "ISOYEAR", "ISPICKVAL", "LEFT", "LEN", "LN", "LOG", "LOWER", "LPAD",
  "MAX", "MCEILING", "MFLOOR", "MID", "MILLISECOND", "MIN", "MINUTE", "MOD", "MONTH",
  "NOT", "NOW", "NULLVALUE", "OR", "PI", "PICKLISTCOUNT", "REVERSE", "RIGHT", "ROUND",
  "RPAD", "SECOND", "SIN", "SQRT", "SUBSTITUTE", "TAN", "TEXT", "TIMENOW", "TIMEVALUE",
  "TODAY", "TRIM", "TRUNC", "UNIXTIMESTAMP", "UPPER", "VALUE", "WEEKDAY", "YEAR",
  "TRUE", "FALSE", "NULL"
];

export const TOKEN_TYPE = {
  FUNCTION: "function",
  FIELD: "field",
  STRING: "string",
  NUMBER: "number",
  OPERATOR: "operator",
  BRACKET: "bracket",
  COMMENT: "comment",
  TEXT: "text"
};

export const COLLAPSIBLE_FUNCTIONS = ["IF", "AND", "OR", "CASE"];

const TAB_SIZE = 4;
const COLOR_DEPTH_CYCLE = 7;

// ---------------------------------------------------------------------------
// Formatting: raw formula string -> prettified multi-line string
// ---------------------------------------------------------------------------

function getIndent(depth) {
  return " ".repeat(depth * TAB_SIZE);
}

// Function name immediately preceding an opening bracket (upper-case letters only).
function extractFunctionName(formula, bracketIndex) {
  let lookback = bracketIndex - 1;
  while (lookback >= 0 && /\s/.test(formula[lookback])) lookback--;

  let functionName = "";
  while (lookback >= 0 && /[A-Z]/.test(formula[lookback])) {
    functionName = formula[lookback] + functionName;
    lookback--;
  }
  return functionName;
}

// True if the bracket pair opening at openBracketIndex directly contains another
// "(" before its matching ")". This is what decides whether a call renders
// multi-line (each arg on its own line, closing paren dedented) vs. inline.
function hasNestedBracketsInside(formula, openBracketIndex) {
  let scanPos = openBracketIndex + 1;
  while (scanPos < formula.length) {
    const ch = formula[scanPos];
    if (ch === "\"" || ch === "'") {
      scanPos++;
      while (scanPos < formula.length && formula[scanPos] !== ch) scanPos++;
      scanPos++;
      continue;
    }
    if (ch === "(") return true;
    if (ch === ")") return false;
    scanPos++;
  }
  return false;
}

function extractStringLiteral(formula, startIndex, quoteChar) {
  let str = quoteChar;
  let i = startIndex + 1;
  while (i < formula.length && formula[i] !== quoteChar) {
    str += formula[i];
    i++;
  }
  str += quoteChar;
  return str;
}

function extractComment(formula, startIndex) {
  let comment = "/*";
  let i = startIndex + 2;
  while (i < formula.length - 1) {
    comment += formula[i];
    if (formula[i] === "*" && formula[i + 1] === "/") {
      comment += "/";
      break;
    }
    i++;
  }
  return comment;
}

export function formatFormula(formula) {
  let result = "";
  const indentStack = [0];
  const bracketInfoStack = [];
  let justAddedComment = false;

  for (let i = 0; i < formula.length; i++) {
    const char = formula[i];
    const nextChar = formula[i + 1];

    if (char === "/" && nextChar === "*") {
      const comment = extractComment(formula, i);
      const currentDepth = indentStack[indentStack.length - 1];
      const expectedIndent = getIndent(currentDepth);

      if (result.trim().length > 0) {
        const endsWithNewlineAndIndent = result.endsWith("\n" + expectedIndent);
        if (!endsWithNewlineAndIndent) {
          if (!result.endsWith("\n")) {
            result += "\n";
          }
          result += expectedIndent;
        }
        result += comment;
      } else {
        result += comment;
      }

      justAddedComment = true;
      i += comment.length - 1;
    } else if (char === "(") {
      if (justAddedComment) {
        const currentDepth = indentStack[indentStack.length - 1];
        result += "\n" + getIndent(currentDepth);
        justAddedComment = false;
      }
      const functionName = extractFunctionName(formula, i);
      const hasNested = hasNestedBracketsInside(formula, i);

      bracketInfoStack.push({isMultiline: hasNested, functionName});
      result += "(";

      const currentDepth = indentStack[indentStack.length - 1];
      const newDepth = currentDepth + 1;
      indentStack.push(newDepth);

      if (hasNested) {
        result += "\n" + getIndent(newDepth);
      }
    } else if (char === ")") {
      const bracketInfo = bracketInfoStack.pop();
      indentStack.pop();

      if (bracketInfo?.isMultiline) {
        const parentDepth = indentStack[indentStack.length - 1];
        result += "\n" + getIndent(parentDepth) + ")";
      } else {
        result += ")";
      }

      // If the next chars are an operator followed by a multi-line function call,
      // break the operator onto a new line before that nested function.
      let operatorMatch = formula.substring(i + 1).match(/^(\s*)(&&|\|\||<=|>=|<>|[+\-*/^&=<>])/);
      if (operatorMatch) {
        const operator = operatorMatch[2];
        let lookAhead = i + 1 + operatorMatch[0].length;
        while (lookAhead < formula.length && /\s/.test(formula[lookAhead])) lookAhead++;

        let foundBracket = -1;
        while (lookAhead < formula.length && /[A-Z]/.test(formula[lookAhead])) {
          lookAhead++;
        }
        if (formula[lookAhead] === "(") {
          foundBracket = lookAhead;
        }

        if (foundBracket > 0 && hasNestedBracketsInside(formula, foundBracket)) {
          const parentDepth = indentStack[indentStack.length - 1];
          result += operator + "\n" + getIndent(parentDepth);
          i += operatorMatch[0].length;
        }
      }
    } else if (char === ",") {
      result += ",";

      const currentBracket = bracketInfoStack[bracketInfoStack.length - 1];
      if (currentBracket?.isMultiline) {
        const currentDepth = indentStack[indentStack.length - 1];
        result += "\n" + getIndent(currentDepth);
      } else {
        result += " ";
      }

      if (nextChar === " ") i++;
    } else if (char === "\"" || char === "'") {
      const stringLiteral = extractStringLiteral(formula, i, char);
      result += stringLiteral;
      i += stringLiteral.length - 1;
    } else if (char === " " && (formula[i - 1] === "(" || formula[i - 1] === ",")) {
      // Skip whitespace immediately after an opening bracket or comma.
    } else {
      if (justAddedComment && char !== " ") {
        const currentDepth = indentStack[indentStack.length - 1];
        result += "\n" + getIndent(currentDepth);
        justAddedComment = false;
      }
      result += char;
    }
  }

  return result.trim();
}

// ---------------------------------------------------------------------------
// Tokenizing: prettified string -> render model (lines of classified tokens)
// ---------------------------------------------------------------------------

function createToken(part, functions, currentDepth, showWhenCollapsed) {
  let type = TOKEN_TYPE.TEXT;
  let bracketDepth = null;

  if (/^\/\*.*\*\/$/.test(part)) {
    type = TOKEN_TYPE.COMMENT;
  } else if (functions.includes(part)) {
    type = TOKEN_TYPE.FUNCTION;
  } else if (/^"[^"]*"$/.test(part) || /^'[^']*'$/.test(part)) {
    type = TOKEN_TYPE.STRING;
  } else if (/^\d+\.?\d*$/.test(part)) {
    type = TOKEN_TYPE.NUMBER;
  } else if (/^(NULL|TRUE|FALSE)$/i.test(part)) {
    // Salesforce formula literals are values, not field references.
    type = TOKEN_TYPE.NUMBER;
  } else if (/^\$?[A-Za-z_][a-zA-Z0-9_]*(__[cr])?$/.test(part)
             || /^\$?[A-Za-z_][a-zA-Z0-9_]*[:.][a-zA-Z0-9_.:]+/.test(part)) {
    type = TOKEN_TYPE.FIELD;
  } else if (/^(==|!=|<=|>=|<>|&&|\|\||[+\-*/^<>=&|])$/.test(part)) {
    type = TOKEN_TYPE.OPERATOR;
  } else if (part === "(" || part === ")") {
    type = TOKEN_TYPE.BRACKET;
    bracketDepth = part === "(" ? currentDepth : currentDepth - 1;
  }

  // Field paths get zero-width spaces after "." and ":" so long paths can wrap.
  let displayText = part;
  if (type === TOKEN_TYPE.FIELD) {
    displayText = part.replace(/\./g, ".​").replace(/:/g, ":​");
  }

  return {
    text: part,
    displayText,
    type,
    cssClass: `token-${type}`,
    bracketDepth,
    colorDepth: bracketDepth !== null ? bracketDepth % COLOR_DEPTH_CYCLE : null,
    showWhenCollapsed
  };
}

function tokenizeLine(line, functions, startDepth) {
  const tokens = [];
  const trimmed = line.trim();
  let currentDepth = startDepth;
  let foundFirstComma = false;

  const parts = trimmed
    .split(/(\s+|[(,)]|==|!=|<=|>=|<>|&&|\|\||\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|[+\-*/^<>=&|]|"[^"]*"|'[^']*')/g)
    .filter(p => p && p.trim());

  parts.forEach((part, index) => {
    const tokenInfo = createToken(part, functions, currentDepth, !foundFirstComma);

    if (part === ",") {
      foundFirstComma = true;
    }

    if (tokenInfo.type === TOKEN_TYPE.BRACKET) {
      if (part === "(") {
        currentDepth++;
      } else if (part === ")") {
        currentDepth--;
      }
    }

    // Spacing around operators and brackets, matching the app's display rules.
    let displayText = tokenInfo.displayText;
    const prevToken = tokens.length > 0 ? tokens[tokens.length - 1] : null;
    const nextPart = index < parts.length - 1 ? parts[index + 1] : null;

    if (tokenInfo.type === TOKEN_TYPE.OPERATOR) {
      const spaceBefore = prevToken ? " " : "";
      const spaceAfter = nextPart ? " " : "";
      displayText = spaceBefore + displayText + spaceAfter;
    } else if (tokenInfo.type === TOKEN_TYPE.BRACKET) {
      if (part === "(") {
        const spaceAfter = (nextPart && nextPart !== ")") ? " " : "";
        displayText = displayText + spaceAfter;
      } else if (part === ")") {
        const prevPart = prevToken ? prevToken.text : null;
        const spaceBefore = (prevToken && prevPart !== "(") ? " " : "";
        displayText = spaceBefore + displayText;
      }
    }

    tokens.push({
      id: tokens.length,
      ...tokenInfo,
      displayText
    });
  });

  return {tokens, endDepth: currentDepth};
}

export function parseLinesToTree(code, functions = FORMULA_FUNCTIONS) {
  const lines = code.split("\n");

  const result = [];
  const collapsibleStack = [];
  const bracketStack = [];
  let globalDepth = 0;
  let bracketPairId = 0;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const tokenResult = tokenizeLine(line, functions, globalDepth);
    const tokens = tokenResult.tokens;
    const lineStartDepth = globalDepth;
    globalDepth = tokenResult.endDepth;

    // Pair up matching brackets so a hovered bracket can highlight its partner.
    tokens.forEach(token => {
      if (token.type === TOKEN_TYPE.BRACKET) {
        if (token.text === "(") {
          token.bracketPairId = bracketPairId;
          bracketStack.push({id: bracketPairId, depth: token.bracketDepth});
          bracketPairId++;
        } else if (token.text === ")") {
          for (let i = bracketStack.length - 1; i >= 0; i--) {
            if (bracketStack[i].depth === token.bracketDepth) {
              token.bracketPairId = bracketStack[i].id;
              bracketStack.splice(i, 1);
              break;
            }
          }
        }
      }
    });

    const isClosingBracketLine = trimmed.startsWith(")");
    const displayDepth = isClosingBracketLine ? globalDepth : lineStartDepth;

    const isCollapsible = /(IF|AND|OR|CASE)\s*\(/.test(trimmed);

    const lineObj = {
      id: index,
      lineNumber: index + 1,
      tokens,
      indentStyle: `padding-left: ${displayDepth * TAB_SIZE}ch;`,
      indentLevel: displayDepth,
      isCollapsible,
      isCollapsed: false,
      hasCollapseToggle: false,
      collapseDepth: null,
      parentId: collapsibleStack.length > 0 ? collapsibleStack[collapsibleStack.length - 1] : null,
      closingLineId: null,
      openingDepth: null
    };

    result.push(lineObj);

    // A collapsible function opens a collapse region at its "(" depth.
    tokens.forEach((token, tokenIndex) => {
      if (token.type === TOKEN_TYPE.FUNCTION && COLLAPSIBLE_FUNCTIONS.includes(token.text)) {
        for (let i = tokenIndex + 1; i < tokens.length; i++) {
          if (tokens[i].type === TOKEN_TYPE.BRACKET && tokens[i].text === "(") {
            const openingDepth = tokens[i].bracketDepth;
            lineObj.hasCollapseToggle = true;
            lineObj.collapseDepth = openingDepth;
            collapsibleStack.push({lineIndex: index, depth: openingDepth, tokenIndex});
            break;
          }
        }
      }
    });

    // A ")" at a collapse region's depth closes it; record its closing line.
    tokens.forEach(token => {
      if (token.type === TOKEN_TYPE.BRACKET && token.text === ")") {
        for (let i = collapsibleStack.length - 1; i >= 0; i--) {
          if (collapsibleStack[i].depth === token.bracketDepth) {
            const openingLineIdx = collapsibleStack[i].lineIndex;
            result[openingLineIdx].closingLineId = index;
            collapsibleStack.splice(i, 1);
            break;
          }
        }
      }
    });
  });

  return result;
}

// Convenience: raw formula -> {prettified, lines}. Cleans whitespace first,
// exactly as prettifyFormula does in the LWC before formatting.
export function prettify(rawFormula, functions = FORMULA_FUNCTIONS) {
  const cleaned = rawFormula
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const prettified = formatFormula(cleaned);
  const lines = parseLinesToTree(prettified, functions);
  return {prettified, lines};
}

// Extract the full balanced FUNC(...) sub-expression for a function token,
// starting at a given line, walking tokens across lines while tracking bracket
// depth. Ported verbatim from the LWC's extractFunctionExpression — powers the
// on-hover sub-expression evaluation.
export function extractFunctionExpression(lines, lineIndex, functionName) {
  const line = lines[lineIndex];
  if (!line) return null;

  let expression = "";
  let depth = 0;
  let started = false;
  let foundFunction = false;

  for (let i = lineIndex; i < lines.length; i++) {
    const currentLine = lines[i];
    for (const token of currentLine.tokens) {
      if (!foundFunction) {
        if (token.type === TOKEN_TYPE.FUNCTION && token.text === functionName) {
          foundFunction = true;
          expression += token.text;
        }
        continue;
      }
      expression += token.text;
      if (token.type === TOKEN_TYPE.BRACKET) {
        if (token.text === "(") {
          depth++;
          started = true;
        } else if (token.text === ")") {
          depth--;
          if (started && depth === 0) {
            return expression.trim();
          }
        }
      }
    }
  }
  return expression.trim();
}
