/* Formula Prettifier — live formula evaluation.
 *
 * This module reproduces the AppExchange app's formula-evaluation pipeline
 * EXACTLY, because that logic encodes many hard-won nuances (field types, Id
 * casting, percent scaling, blank handling, return-type retries) that must not
 * change. The app runs the evaluation in TWO phases, and we keep that split on
 * purpose:
 *
 *   Phase 1 (Apex, once per formula):  parse the formula's field references,
 *     query the record, and return each referenced field's VALUE + TYPE.
 *   Phase 2 (client JS, then Apex):    substitute those values into the formula
 *     (replaceFieldsWithValues) and evaluate the substituted expression with
 *     Salesforce's Formula.builder() engine.
 *
 * WHY the split — and why substitution happens in JS rather than letting Apex
 * do everything: Salesforce's Formula.builder() cannot resolve certain things
 * against a record (global variables like $User/$Organization/$Setup/
 * $CustomMetadata; and value shapes such as Date/Time/DateTime, which must be
 * expressed as DATEVALUE("…") etc.). So the client converts what
 * Formula.builder() can't handle into literal formula syntax it CAN handle, and
 * deliberately LEAVES picklist / multipicklist / reference fields as bare
 * references so Apex evaluates them against the real queried record. Collapsing
 * this into one Apex call would reintroduce exactly the failures the app
 * already solved. The split also makes on-hover sub-expression evaluation
 * cheap: phase 1 runs once, then every hovered sub-expression reuses the
 * cached values and only re-runs phase 2.
 *
 * In the browser there is no packaged Apex, so each phase runs as ANONYMOUS
 * Apex via the Tooling API's executeAnonymous. The anonymous block contains the
 * app's Apex logic verbatim (as local classes) and surfaces its result by
 * throwing an exception whose message is the result — executeAnonymous returns
 * that message directly in `exceptionMessage`, so no debug-log/TraceFlag round
 * trip is needed. A sentinel prefix marks our intentional "result" throws so we
 * can tell them apart from genuine Apex errors.
 *
 * Requires the running user to have the "Author Apex" permission (anonymous
 * Apex). Callers should gate the evaluation UI on canRunApex() and degrade to
 * formatting-only when it's absent.
 */
import {sfConn, apiVersion} from "./inspector.js";

export const UNABLE_TO_EVALUATE = "Unable to evaluate";

// Marks a deliberate "here is the result" throw from our anonymous Apex so we
// can distinguish it from a real compile/runtime error.
const RESULT_SENTINEL = "__FP_RESULT__";
const NULL_MARKER = "__NULL__";

// ===========================================================================
// Client-side value substitution — ported VERBATIM from the LWC
// (formulaPrettifier.js detectNonReplaceableFields / replaceFieldsWithValues
// and the isDate/isTime/isDateTime/isNumericFieldType helpers).
// ===========================================================================

// Field types whose values are NOT substituted client-side: they stay as bare
// field references so Formula.builder() resolves them against the queried
// record. (Picklist API values / reference ids don't round-trip as literals.)
const NON_REPLACEABLE_TYPES = ["PICKLIST", "MULTIPICKLIST", "REFERENCE"];
const NUMERIC_TYPES = ["CURRENCY", "DOUBLE", "INTEGER", "LONG", "PERCENT", "NUMBER"];

function detectNonReplaceableFields(fieldTypes) {
  const nonReplaceable = new Set();
  const types = fieldTypes || {};
  for (const fieldName of Object.keys(types)) {
    // Global variables ($User, $Setup, $CustomMetadata, …) must always be
    // substituted — Formula.builder() can't resolve them without
    // withGlobalVariables, which this pipeline does not use.
    if (/^\$/.test(fieldName)) continue;
    const t = types[fieldName];
    if (t && NON_REPLACEABLE_TYPES.includes(t.toUpperCase())) {
      nonReplaceable.add(fieldName);
    }
  }
  return nonReplaceable;
}

function isDateTime(value) {
  if (typeof value !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
}
function formatDateTimeForFormula(isoDateTime) {
  // 2025-10-18T18:37:03.000Z -> 2025-10-18 18:37:03
  return isoDateTime.replace(/\.\d{3}Z?$/, "").replace("T", " ");
}
function isTime(value) {
  if (typeof value !== "string") return false;
  return /^\d{2}:\d{2}:\d{2}$/.test(value);
}
function isDate(value) {
  if (typeof value !== "string") return false;
  // Apex returns Date fields as "YYYY-MM-DD" or "YYYY-MM-DD 00:00:00".
  return /^\d{4}-\d{2}-\d{2}( 00:00:00)?$/.test(value);
}
function isNumericFieldType(fieldKey, fieldTypes) {
  const t = (fieldTypes || {})[fieldKey];
  if (!t) return false;
  return NUMERIC_TYPES.includes(t.toUpperCase());
}

/**
 * Substitute field references in a formula with their fetched values, exactly
 * as the app's replaceFieldsWithValues does. Returns the expression ready for
 * Formula.builder().
 *
 * @param {string} expression
 * @param {Object} fieldValues  fieldRef -> value (nulls already un-marked)
 * @param {Object} fieldTypes   fieldRef -> Salesforce field type name
 */
export function replaceFieldsWithValues(expression, fieldValues, fieldTypes) {
  if (!fieldValues) return expression;

  const nonReplaceable = detectNonReplaceableFields(fieldTypes);
  let result = expression;

  // Longest keys first so a shorter key never partially overwrites a longer one.
  const fields = Object.keys(fieldValues).sort((a, b) => b.length - a.length);

  for (const fieldKey of fields) {
    if (!Object.prototype.hasOwnProperty.call(fieldValues, fieldKey)) continue;
    const value = fieldValues[fieldKey];
    if (nonReplaceable.has(fieldKey)) continue;

    let formattedValue;
    if (value === null || value === undefined) {
      // Global variables ($User, $Profile, …) MUST be replaced — Formula.builder
      // can't resolve them; a null global becomes "". Record-field nulls are
      // left as references so Apex resolves them against the record.
      const isGlobalVar = /^\$/.test(fieldKey);
      if (!isGlobalVar) continue;
      formattedValue = "\"\"";
    } else if (typeof value === "boolean") {
      formattedValue = value ? "TRUE" : "FALSE";
    } else if (typeof value === "number") {
      formattedValue = String(value);
    } else if (value === "") {
      formattedValue = "\"\"";
    } else if (isDateTime(value)) {
      formattedValue = "DATETIMEVALUE(\"" + formatDateTimeForFormula(value) + "\")";
    } else if (isTime(value)) {
      formattedValue = "TIMEVALUE(\"" + value + ".000\")";
    } else if (isDate(value)) {
      const dateOnly = value.replace(/ 00:00:00$/, "");
      formattedValue = "DATEVALUE(\"" + dateOnly + "\")";
    } else if (typeof value === "string" && value !== "" && !isNaN(value) && isNumericFieldType(fieldKey, fieldTypes)) {
      // Apex Decimal/Currency values can arrive as strings via serialization.
      formattedValue = value;
    } else {
      formattedValue = "\"" + value + "\"";
    }

    // Boundary-guarded replace so we don't match inside a longer identifier/path.
    const escaped = fieldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fieldRegex = new RegExp("(?<![A-Za-z0-9_.:])" + escaped + "(?![A-Za-z0-9_.])", "g");
    result = result.replace(fieldRegex, formattedValue);
  }
  return result;
}

// ===========================================================================
// Client-side result parsing — HYPERLINK / IMAGE markers.
// Formula.evaluate() returns these as Salesforce's internal encoded form:
//   HYPERLINK → _HL_ENCODED_<url>_HL_<label>_HL_<target>_HL_
//   IMAGE     → _IM1_<src>_IM2_<alt>_IM3_[<height>_IM4_<width>]
// where <label> may itself be an IMAGE encoding. We convert that into the HTML
// Salesforce would render on a record page, so tooltips / the Result badge show
// usable markup instead of the raw tokens.
// ===========================================================================

export function isResultHyperlink(result) {
  return !!result && typeof result === "string" && result.indexOf("_HL_ENCODED_") !== -1;
}

export function isResultImage(result) {
  return !!result && typeof result === "string" && result.indexOf("_IM1_") !== -1;
}

function decodeMaybeUri(value) {
  if (!value) return value;
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Convert an IMAGE encoding (_IM1_…_IM2_…_IM3_…) into an <img> tag.
 * Returns null if the string does not contain a recognizable IMAGE encoding.
 */
export function imageEncodingToHtml(encoded) {
  if (!encoded || typeof encoded !== "string") return null;
  const im1 = encoded.indexOf("_IM1_");
  if (im1 === -1) return null;
  const afterIm1 = encoded.substring(im1 + "_IM1_".length);
  const im2 = afterIm1.indexOf("_IM2_");
  if (im2 === -1) return null;
  const src = decodeMaybeUri(afterIm1.substring(0, im2));
  const afterIm2 = afterIm1.substring(im2 + "_IM2_".length);
  const im3 = afterIm2.indexOf("_IM3_");
  if (im3 === -1) return null;
  const alt = decodeMaybeUri(afterIm2.substring(0, im3));
  let rest = afterIm2.substring(im3 + "_IM3_".length);
  // Optional height / width: _IM3_<height>_IM4_<width> (may be empty).
  let height = "";
  let width = "";
  if (rest) {
    // Stop at the next HYPERLINK delimiter if IMAGE is nested inside one.
    const hlCut = rest.indexOf("_HL_");
    if (hlCut !== -1) rest = rest.substring(0, hlCut);
    const im4 = rest.indexOf("_IM4_");
    if (im4 !== -1) {
      height = rest.substring(0, im4).trim();
      width = rest.substring(im4 + "_IM4_".length).replace(/_+$/, "").trim();
    } else {
      const bare = rest.replace(/_+$/, "").trim();
      if (bare) height = bare;
    }
  }
  let html = '<img src="' + src + '" alt="' + alt + '" border="0"';
  if (height) html += ' height="' + height + '"';
  if (width) html += ' width="' + width + '"';
  html += "/>";
  return html;
}

/**
 * Parse a HYPERLINK encoding into {url, label, target}. Label may still contain
 * an IMAGE encoding (caller can run imageEncodingToHtml on it).
 */
export function parseHyperlink(result) {
  if (!isResultHyperlink(result)) return null;
  const encodedIndex = result.indexOf("_HL_ENCODED_");
  const afterEncoded = result.substring(encodedIndex + "_HL_ENCODED_".length);
  const parts = afterEncoded.split("_HL_");
  // parts: [url, label, target, ...trailing empties]
  const url = decodeMaybeUri((parts[0] || "").trim());
  const label = parts.length > 1 ? parts[1] : "";
  let target = parts.length > 2 ? (parts[2] || "").trim() : "";
  // Salesforce stores "_self" / "_blank"; a bare "blank" also appears.
  if (target === "blank") target = "_blank";
  if (!target) target = "_blank";
  if (!url) return null;
  return {url, label, target};
}

/**
 * Turn a Formula.evaluate() string result into display HTML for HYPERLINK /
 * IMAGE (nested or alone). Non-encoded results are returned unchanged.
 */
export function formatEncodedFormulaResult(result) {
  if (result == null || typeof result !== "string") return result;
  if (isResultHyperlink(result)) {
    const parsed = parseHyperlink(result);
    if (!parsed) return result;
    let inner = parsed.label;
    if (inner && inner.indexOf("_IM1_") !== -1) {
      inner = imageEncodingToHtml(inner) || inner;
    }
    // Match Salesforce's rendered markup (target included even when _self).
    return '<a href="' + parsed.url + '" target="' + parsed.target + '">' + (inner || "") + "</a>";
  }
  if (isResultImage(result)) {
    return imageEncodingToHtml(result) || result;
  }
  return result;
}

// ===========================================================================
// Anonymous Apex — running the app's Apex logic verbatim via executeAnonymous.
// ===========================================================================

// Apex string-literal escaping for values we inline into the anonymous block.
function apexStr(s) {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "") + "'";
}

// The shared FormulaDataFetcher logic (extractFieldReferences, queryRecord,
// field-value/type fetching, globals) + the app's error-string constants and
// FORMULA_FUNCTIONS set, as a self-contained local Apex class. Ported VERBATIM
// from FormulaDataFetcher.cls / PrettifierConstants.cls (only `public with
// sharing class X {` headers changed to local `class X {`, and @AuraEnabled/
// @TestVisible annotations dropped — they're meaningless in anonymous Apex).
const APEX_FETCHER = `
class FpResultException extends Exception {}
class FpFetchResult { public Map<String,Object> fieldValues; public Map<String,String> fieldTypes;
  public FpFetchResult(){ this.fieldValues = new Map<String,Object>(); this.fieldTypes = new Map<String,String>(); } }
class FpFetcher {
  final String FIELD_SEPARATOR = '.';
  final String GLOBAL_USER = '$User';
  final String GLOBAL_PROFILE = '$Profile';
  final String GLOBAL_ORGANIZATION = '$Organization';
  final String GLOBAL_USERROLE = '$UserRole';
  final String GLOBAL_CUSTOMMETADATA = '$CustomMetadata';
  final String GLOBAL_SETUP = '$Setup';
  final Set<String> FORMULA_FUNCTIONS = new Set<String>{
    'ACOS','ADDMONTHS','AND','ASCII','ASIN','ATAN','ATAN2','BEGINS','BLANKVALUE',
    'BR','CASE','CASESAFEID','CEILING','CHR','CONTAINS','COS','CURRENCYRATE',
    'DATE','DATETIMEVALUE','DATEVALUE','DAY','DAYOFYEAR','DISTANCE','EXP','FIND',
    'FLOOR','FORMATDURATION','FROMUNIXTIME','GEOLOCATION','GETSESSIONID','HOUR',
    'HYPERLINK','IF','IMAGE','INCLUDES','INITCAP','ISBLANK','ISNULL','ISNUMBER',
    'ISOWEEK','ISOYEAR','ISPICKVAL','LEFT','LEN','LN','LOG','LOWER','LPAD',
    'MAX','MCEILING','MFLOOR','MID','MILLISECOND','MIN','MINUTE','MOD','MONTH',
    'NOT','NOW','NULLVALUE','OR','PI','PICKLISTCOUNT','REVERSE','RIGHT','ROUND',
    'RPAD','SECOND','SIN','SQRT','SUBSTITUTE','TAN','TEXT','TIMENOW','TIMEVALUE',
    'TODAY','TRIM','TRUNC','UNIXTIMESTAMP','UPPER','VALUE','WEEKDAY','YEAR',
    'TRUE','FALSE','NULL'
  };

  public FpFetchResult fetchFieldData(String formula, String objectApiName, Id recordId) {
    FpFetchResult result = new FpFetchResult();
    Set<String> fieldReferences = extractFieldReferences(formula);
    if (recordId != null && !fieldReferences.isEmpty()) {
      Schema.SObjectType objType = recordId.getSObjectType();
      result.fieldValues = fetchFieldValues(objectApiName, recordId, fieldReferences, result.fieldTypes, objType);
    }
    return result;
  }

  Map<String,Object> fetchFieldValues(String objectApiName, Id recordId, Set<String> fieldReferences, Map<String,String> fieldTypes, Schema.SObjectType objType) {
    Map<String,Object> values = new Map<String,Object>();
    if (fieldReferences.isEmpty() || recordId == null || objType == null) return values;
    Map<String,Set<String>> categorizedFields = categorizeFieldReferences(fieldReferences);
    // Record fields need object access; globals ($User, $Setup, $CustomMetadata, …)
    // are independent and must still resolve when the record object is locked down.
    Schema.DescribeSObjectResult objDescribe = objType.getDescribe();
    if (objDescribe.isAccessible() && !categorizedFields.get('main').isEmpty()) {
      fetchMainObjectFields(values, fieldTypes, objectApiName, recordId, categorizedFields.get('main'), objType, objDescribe);
    }
    Set<String> globalKeys = new Set<String>{ GLOBAL_USER, GLOBAL_PROFILE, GLOBAL_ORGANIZATION, GLOBAL_USERROLE };
    for (String globalKey : globalKeys) {
      if (categorizedFields.containsKey(globalKey) && !categorizedFields.get(globalKey).isEmpty()) {
        fetchGlobalVariableFields(values, globalKey, categorizedFields.get(globalKey));
      }
    }
    if (categorizedFields.containsKey(GLOBAL_CUSTOMMETADATA) && !categorizedFields.get(GLOBAL_CUSTOMMETADATA).isEmpty()) {
      fetchCustomMetadataFields(values, fieldTypes, categorizedFields.get(GLOBAL_CUSTOMMETADATA));
    }
    if (categorizedFields.containsKey(GLOBAL_SETUP) && !categorizedFields.get(GLOBAL_SETUP).isEmpty()) {
      fetchSetupFields(values, fieldTypes, categorizedFields.get(GLOBAL_SETUP));
    }
    return values;
  }

  public Set<String> extractFieldReferences(String formula) {
    Set<String> fields = new Set<String>();
    String cleanFormula = formula
      .replaceAll('\\\\u200B', '')
      .replaceAll('/\\\\*.*?\\\\*/', '')
      .replaceAll('"[^"]*"', '');
    List<String> tokens = cleanFormula.split('[^A-Za-z0-9_\\\\.\\\\$:]');
    for (String token : tokens) {
      if (String.isNotBlank(token) && !token.isNumeric() && !FORMULA_FUNCTIONS.contains(token.toUpperCase())) {
        fields.add(token);
      }
    }
    return fields;
  }

  void populateFieldTypes(Map<String,String> fieldTypes, Set<String> fieldRefs, Schema.SObjectType objType, Schema.DescribeSObjectResult objDescribe) {
    Map<String,Schema.SObjectField> baseFieldMap = objDescribe.fields.getMap();
    for (String fieldRef : fieldRefs) {
      try {
        String soqlPath = convertToSoqlPath(fieldRef);
        Schema.SObjectType currentObjType = objType;
        Map<String,Schema.SObjectField> currentFieldMap = baseFieldMap;
        List<String> pathParts = soqlPath.split('\\\\.');
        for (Integer i = 0; i < pathParts.size(); i++) {
          String fieldName = pathParts[i];
          String lookupFieldName = fieldName;
          if (i < pathParts.size() - 1 && fieldName.endsWithIgnoreCase('__r')) {
            lookupFieldName = fieldName.substringBeforeLast('__r') + '__c';
          }
          Schema.SObjectField fieldToken = currentFieldMap.get(lookupFieldName);
          if (fieldToken == null && i < pathParts.size() - 1) {
            if (!lookupFieldName.endsWith('Id') && !lookupFieldName.endsWith('__c')) {
              fieldToken = currentFieldMap.get(lookupFieldName + 'Id');
            }
          }
          if (fieldToken != null) {
            Schema.DescribeFieldResult fieldDescribe = fieldToken.getDescribe();
            if (i == pathParts.size() - 1) {
              fieldTypes.put(fieldRef, String.valueOf(fieldDescribe.getType()));
            } else {
              List<Schema.SObjectType> referenceTo = fieldDescribe.getReferenceTo();
              if (!referenceTo.isEmpty()) {
                currentObjType = referenceTo[0];
                currentFieldMap = currentObjType.getDescribe().fields.getMap();
              }
            }
          } else { break; }
        }
      } catch (Exception e) { /* skip unresolved field */ }
    }
  }

  Map<String,Set<String>> categorizeFieldReferences(Set<String> fieldReferences) {
    Map<String,Set<String>> categorized = new Map<String,Set<String>>{
      'main' => new Set<String>(), GLOBAL_USER => new Set<String>(), GLOBAL_PROFILE => new Set<String>(),
      GLOBAL_ORGANIZATION => new Set<String>(), GLOBAL_USERROLE => new Set<String>(),
      GLOBAL_CUSTOMMETADATA => new Set<String>(), GLOBAL_SETUP => new Set<String>() };
    for (String fieldRef : fieldReferences) {
      String globalPrefix = getGlobalPrefix(fieldRef);
      if (globalPrefix != null) categorized.get(globalPrefix).add(fieldRef);
      else categorized.get('main').add(fieldRef);
    }
    return categorized;
  }

  String getGlobalPrefix(String fieldRef) {
    // $UserRole must be checked before $User ($User is a prefix of $UserRole).
    if (fieldRef.startsWith(GLOBAL_USERROLE + FIELD_SEPARATOR)) return GLOBAL_USERROLE;
    if (fieldRef.startsWith(GLOBAL_USER + FIELD_SEPARATOR)) return GLOBAL_USER;
    if (fieldRef.startsWith(GLOBAL_PROFILE + FIELD_SEPARATOR)) return GLOBAL_PROFILE;
    if (fieldRef.startsWith(GLOBAL_ORGANIZATION + FIELD_SEPARATOR)) return GLOBAL_ORGANIZATION;
    if (fieldRef.startsWith(GLOBAL_CUSTOMMETADATA + FIELD_SEPARATOR)) return GLOBAL_CUSTOMMETADATA;
    if (fieldRef.startsWith(GLOBAL_SETUP + FIELD_SEPARATOR)) return GLOBAL_SETUP;
    return null;
  }

  public SObject queryRecord(String objectApiName, Id recordId, Set<String> fieldReferences, Schema.SObjectType objType, Schema.DescribeSObjectResult objDescribe) {
    try {
      String validatedObjectName = objDescribe.getName();
      if (String.isBlank(validatedObjectName) || validatedObjectName != objectApiName) return null;
      Set<String> accessibleFields = new Set<String>();
      Map<String,Schema.SObjectField> fieldMap = objDescribe.fields.getMap();
      for (String fieldRef : fieldReferences) {
        String baseField = fieldRef.contains('.') ? fieldRef.substringBefore('.') : fieldRef;
        baseField = baseField.contains(':') ? baseField.substringBefore(':') : baseField;
        Schema.SObjectField field = fieldMap.get(baseField);
        if (field == null && !baseField.endsWith('Id') && !baseField.endsWith('__r')) field = fieldMap.get(baseField + 'Id');
        if (field == null && baseField.endsWith('__r')) field = fieldMap.get(baseField.replace('__r','__c'));
        if (field != null && field.getDescribe().isAccessible()) accessibleFields.add(fieldRef);
      }
      if (accessibleFields.isEmpty()) return null;
      List<String> soqlFields = new List<String>();
      for (String fieldRef : accessibleFields) soqlFields.add(convertToSoqlPath(fieldRef));
      String query = 'SELECT ' + String.join(soqlFields, ', ') + ' FROM ' + validatedObjectName + ' WHERE Id = :recordId WITH SECURITY_ENFORCED LIMIT 1';
      List<SObject> records = Database.query(query);
      return records.isEmpty() ? null : records[0];
    } catch (QueryException e) { return null; } catch (Exception e) { return null; }
  }

  void fetchMainObjectFields(Map<String,Object> values, Map<String,String> fieldTypes, String objectApiName, Id recordId, Set<String> fieldReferences, Schema.SObjectType objType, Schema.DescribeSObjectResult objDescribe) {
    populateFieldTypes(fieldTypes, fieldReferences, objType, objDescribe);
    SObject record = queryRecord(objectApiName, recordId, fieldReferences, objType, objDescribe);
    if (record != null) {
      for (String fieldRef : fieldReferences) {
        try { values.put(fieldRef, getFieldValue(record, fieldRef)); } catch (Exception e) { /* field not accessible */ }
      }
    }
  }

  void fetchGlobalVariableFields(Map<String,Object> values, String globalType, Set<String> fields) {
    try {
      Id userId = UserInfo.getUserId();
      if (globalType == GLOBAL_USER) fetchUserFields(values, fields, userId);
      else if (globalType == GLOBAL_PROFILE) fetchProfileFields(values, fields, userId);
      else if (globalType == GLOBAL_ORGANIZATION) fetchOrganizationFields(values, fields);
      else if (globalType == GLOBAL_USERROLE) fetchUserRoleFields(values, fields, userId);
    } catch (Exception e) { /* skip global */ }
  }

  Set<String> getAccessibleFields(Set<String> fields, Map<String,Schema.SObjectField> fieldMap, String prefix) {
    Set<String> accessibleFields = new Set<String>();
    for (String field : fields) {
      String fieldName = String.isNotBlank(prefix) ? field.replace(prefix + FIELD_SEPARATOR, '') : field;
      Schema.SObjectField sField = fieldMap.get(fieldName);
      if (sField != null && sField.getDescribe().isAccessible()) accessibleFields.add(fieldName);
    }
    return accessibleFields;
  }

  void populateFieldValues(Map<String,Object> values, SObject record, Set<String> fields, Set<String> accessibleFields, String prefix) {
    for (String field : fields) {
      String fieldName = String.isNotBlank(prefix) ? field.replace(prefix + FIELD_SEPARATOR, '') : field;
      if (accessibleFields.contains(fieldName)) values.put(field, record.get(fieldName));
    }
  }

  void fetchUserFields(Map<String,Object> values, Set<String> fields, Id userId) {
    try {
      Map<String,String> userInfoFields = new Map<String,String>{ 'UITheme' => UserInfo.getUiTheme(), 'UIThemeDisplayed' => UserInfo.getUiThemeDisplayed() };
      Set<String> remaining = new Set<String>();
      for (String field : fields) {
        String fieldName = field.replace(GLOBAL_USER + FIELD_SEPARATOR, '');
        if (userInfoFields.containsKey(fieldName)) values.put(field, userInfoFields.get(fieldName));
        else remaining.add(field);
      }
      if (remaining.isEmpty()) return;
      Map<String,Schema.SObjectField> fieldMap = Schema.SObjectType.User.fields.getMap();
      Set<String> accessibleFields = getAccessibleFields(remaining, fieldMap, GLOBAL_USER);
      if (accessibleFields.isEmpty()) return;
      String query = 'SELECT ' + String.join(new List<String>(accessibleFields), ', ') + ' FROM User WHERE Id = :userId WITH SECURITY_ENFORCED LIMIT 1';
      List<User> users = Database.query(query);
      if (!users.isEmpty()) populateFieldValues(values, users[0], remaining, accessibleFields, GLOBAL_USER);
    } catch (Exception e) { /* skip */ }
  }

  void fetchProfileFields(Map<String,Object> values, Set<String> fields, Id userId) {
    try {
      List<User> users = [SELECT ProfileId FROM User WHERE Id = :userId WITH SECURITY_ENFORCED LIMIT 1];
      if (users.isEmpty()) return;
      Id profileId = users[0].ProfileId;
      Map<String,Schema.SObjectField> fieldMap = Schema.SObjectType.Profile.fields.getMap();
      Set<String> accessibleFields = getAccessibleFields(fields, fieldMap, GLOBAL_PROFILE);
      if (accessibleFields.isEmpty()) return;
      String query = 'SELECT ' + String.join(new List<String>(accessibleFields), ', ') + ' FROM Profile WHERE Id = :profileId WITH SECURITY_ENFORCED LIMIT 1';
      List<Profile> profiles = Database.query(query);
      if (!profiles.isEmpty()) populateFieldValues(values, profiles[0], fields, accessibleFields, GLOBAL_PROFILE);
    } catch (Exception e) { /* skip */ }
  }

  void fetchOrganizationFields(Map<String,Object> values, Set<String> fields) {
    try {
      Map<String,Schema.SObjectField> fieldMap = Schema.SObjectType.Organization.fields.getMap();
      Set<String> accessibleFields = getAccessibleFields(fields, fieldMap, GLOBAL_ORGANIZATION);
      if (accessibleFields.isEmpty()) return;
      String query = 'SELECT ' + String.join(new List<String>(accessibleFields), ', ') + ' FROM Organization WITH SECURITY_ENFORCED LIMIT 1';
      List<Organization> orgs = Database.query(query);
      if (!orgs.isEmpty()) populateFieldValues(values, orgs[0], fields, accessibleFields, GLOBAL_ORGANIZATION);
    } catch (Exception e) { /* skip */ }
  }

  void fetchUserRoleFields(Map<String,Object> values, Set<String> fields, Id userId) {
    try {
      List<User> users = [SELECT UserRoleId FROM User WHERE Id = :userId WITH SECURITY_ENFORCED LIMIT 1];
      if (users.isEmpty()) return;
      Id roleId = users[0].UserRoleId;
      if (roleId == null) { for (String field : fields) values.put(field, null); return; }
      Map<String,Schema.SObjectField> fieldMap = Schema.SObjectType.UserRole.fields.getMap();
      Set<String> accessibleFields = getAccessibleFields(fields, fieldMap, GLOBAL_USERROLE);
      if (accessibleFields.isEmpty()) return;
      String query = 'SELECT ' + String.join(new List<String>(accessibleFields), ', ') + ' FROM UserRole WHERE Id = :roleId WITH SECURITY_ENFORCED LIMIT 1';
      List<UserRole> roles = Database.query(query);
      if (!roles.isEmpty()) populateFieldValues(values, roles[0], fields, accessibleFields, GLOBAL_USERROLE);
    } catch (Exception e) { /* skip */ }
  }

  // $CustomMetadata.Type__mdt.RecordDeveloperName.Field__c
  void fetchCustomMetadataFields(Map<String,Object> values, Map<String,String> fieldTypes, Set<String> fields) {
    for (String fieldRef : fields) {
      try {
        String path = fieldRef.substring(GLOBAL_CUSTOMMETADATA.length() + 1);
        List<String> parts = path.split('\\\\.');
        if (parts.size() < 3) continue;
        String typeName = parts[0];
        if (!typeName.endsWithIgnoreCase('__mdt')) typeName += '__mdt';
        String recordName = parts[1];
        List<String> fieldParts = new List<String>();
        for (Integer i = 2; i < parts.size(); i++) fieldParts.add(parts[i]);
        String fieldPath = String.join(fieldParts, '.');
        Schema.SObjectType mdtType = Schema.getGlobalDescribe().get(typeName);
        if (mdtType == null) continue;
        Schema.DescribeSObjectResult mdtDescribe = mdtType.getDescribe();
        if (!mdtDescribe.isAccessible()) continue;
        String leafField = fieldParts[fieldParts.size() - 1];
        Schema.SObjectField sField = mdtDescribe.fields.getMap().get(leafField);
        if (sField == null || !sField.getDescribe().isAccessible()) continue;
        fieldTypes.put(fieldRef, String.valueOf(sField.getDescribe().getType()));
        String soql = 'SELECT ' + fieldPath + ' FROM ' + typeName
          + ' WHERE DeveloperName = \\'' + String.escapeSingleQuotes(recordName) + '\\' LIMIT 1';
        List<SObject> rows = Database.query(soql);
        if (rows.isEmpty()) { values.put(fieldRef, null); continue; }
        values.put(fieldRef, getFieldValue(rows[0], fieldPath));
      } catch (Exception e) { /* skip unresolved CMDT ref */ }
    }
  }

  // $Setup.HierarchySetting__c.Field__c — resolve User > Profile > Org like getInstance().
  void fetchSetupFields(Map<String,Object> values, Map<String,String> fieldTypes, Set<String> fields) {
    for (String fieldRef : fields) {
      try {
        String path = fieldRef.substring(GLOBAL_SETUP.length() + 1);
        List<String> parts = path.split('\\\\.');
        if (parts.size() < 2) continue;
        String settingName = parts[0];
        List<String> fieldParts = new List<String>();
        for (Integer i = 1; i < parts.size(); i++) fieldParts.add(parts[i]);
        String fieldPath = String.join(fieldParts, '.');
        Schema.SObjectType csType = Schema.getGlobalDescribe().get(settingName);
        if (csType == null) continue;
        Schema.DescribeSObjectResult csDescribe = csType.getDescribe();
        if (!csDescribe.isCustomSetting() || !csDescribe.isAccessible()) continue;
        String leafField = fieldParts[fieldParts.size() - 1];
        Schema.SObjectField sField = csDescribe.fields.getMap().get(leafField);
        if (sField == null || !sField.getDescribe().isAccessible()) continue;
        fieldTypes.put(fieldRef, String.valueOf(sField.getDescribe().getType()));
        Id userId = UserInfo.getUserId();
        Id profileId = UserInfo.getProfileId();
        Id orgId = UserInfo.getOrganizationId();
        String soql = 'SELECT SetupOwnerId, ' + fieldPath + ' FROM ' + settingName
          + ' WHERE SetupOwnerId IN (\\'' + userId + '\\',\\'' + profileId + '\\',\\'' + orgId + '\\')';
        Map<Id,SObject> byOwner = new Map<Id,SObject>();
        for (SObject row : Database.query(soql)) {
          byOwner.put((Id)row.get('SetupOwnerId'), row);
        }
        SObject resolved = byOwner.containsKey(userId) ? byOwner.get(userId)
          : (byOwner.containsKey(profileId) ? byOwner.get(profileId) : byOwner.get(orgId));
        values.put(fieldRef, resolved != null ? getFieldValue(resolved, fieldPath) : null);
      } catch (Exception e) { /* skip unresolved $Setup ref */ }
    }
  }

  String convertToSoqlPath(String fieldPath) {
    if (!fieldPath.contains(':')) return fieldPath;
    Integer colonIndex = fieldPath.indexOf(':');
    Integer nextDotIndex = fieldPath.indexOf('.', colonIndex);
    if (nextDotIndex == -1) return fieldPath.substring(0, colonIndex);
    return fieldPath.substring(0, colonIndex) + fieldPath.substring(nextDotIndex);
  }

  Object getFieldValue(SObject record, String fieldPath) {
    String normalizedPath = convertToSoqlPath(fieldPath);
    if (!normalizedPath.contains(FIELD_SEPARATOR)) return record.get(normalizedPath);
    String[] parts = normalizedPath.split('\\\\' + FIELD_SEPARATOR);
    SObject current = record;
    for (Integer i = 0; i < parts.size() - 1; i++) { current = current.getSObject(parts[i]); if (current == null) return null; }
    return current.get(parts[parts.size() - 1]);
  }
}
`;

// The controller's evaluation logic (evaluateFormula + helpers), ported VERBATIM
// from FormulaPrettifierController.cls. Depends on FpFetcher above.
const APEX_EVALUATOR = `
class FpEval {
  FpFetcher fetcher = new FpFetcher();
  final Map<String, FormulaEval.FormulaReturnType> FORMULA_RETURN_TYPE_MAPPING = new Map<String, FormulaEval.FormulaReturnType>{
    'Boolean' => FormulaEval.FormulaReturnType.BOOLEAN,
    'Text' => FormulaEval.FormulaReturnType.STRING,
    'Number' => FormulaEval.FormulaReturnType.DECIMAL,
    'Date' => FormulaEval.FormulaReturnType.DATE,
    'Date/Time' => FormulaEval.FormulaReturnType.DATETIME,
    'Time' => FormulaEval.FormulaReturnType.TIME,
    'Id' => FormulaEval.FormulaReturnType.ID
  };

  Boolean isObjectAccessible(Schema.SObjectType objType) {
    return objType != null && objType.getDescribe().isAccessible();
  }

  public String evaluateFormula(String formulaExpression, String objectApiName, Id recordId, String blankFieldHandling, String fieldDataType) {
    Schema.SObjectType objType;
    Boolean treatBlanksAsZero;
    try {
      if (String.isBlank(formulaExpression) || String.isBlank(objectApiName)) {
        return 'Invalid parameters: expression=' + formulaExpression + ', object=' + objectApiName;
      }
      objType = Schema.getGlobalDescribe().get(objectApiName);
      if (!isObjectAccessible(objType)) return 'No access to object';
      treatBlanksAsZero = blankFieldHandling == 'BlankAsZero';
      formulaExpression = wrapIdLiteralsWithCasting(formulaExpression);
      SObject record;
      if (recordId != null) {
        Set<String> fieldReferences = fetcher.extractFieldReferences(formulaExpression);
        Schema.DescribeSObjectResult objDescribe = objType.getDescribe();
        record = fetcher.queryRecord(objectApiName, recordId, fieldReferences, objType, objDescribe);
        if (record == null) record = objType.newSObject();
      } else {
        record = objType.newSObject();
      }
      return formatResult(buildAndEvaluateFormula(objType, formulaExpression, treatBlanksAsZero, record), fieldDataType);
    } catch (System.SObjectException soe) {
      if (soe.getMessage().contains('without querying the requested field') && recordId != null) {
        try {
          SObject fullRecord = queryAllAccessibleFields(objectApiName, recordId, objType);
          return formatResult(buildAndEvaluateFormula(objType, formulaExpression, treatBlanksAsZero, fullRecord), fieldDataType);
        } catch (Exception retryEx) { return 'Unable to evaluate'; }
      }
      return 'Unable to evaluate';
    } catch (Exception e) {
      return 'Unable to evaluate';
    }
  }

  Object buildAndEvaluateFormula(Schema.SObjectType objType, String formulaExpression, Boolean treatBlanksAsZero, SObject record) {
    try {
      return Formula.builder().withType(objType).withReturnType(FORMULA_RETURN_TYPE_MAPPING.get('Boolean'))
        .withFormula(formulaExpression).treatNumericNullAsZero(treatBlanksAsZero).build().evaluate(record);
    } catch (FormulaValidationException ex) {
      if (ex.getMessage().contains('data type ')) {
        String correctDataType = ex.getMessage().substringAfter('is data type (').substringBefore('),');
        if (correctDataType.startsWith('Lookup(')) correctDataType = 'Id';
        return Formula.builder().withType(objType).withReturnType(FORMULA_RETURN_TYPE_MAPPING.get(correctDataType))
          .withFormula(formulaExpression).treatNumericNullAsZero(treatBlanksAsZero).build().evaluate(record);
      }
      throw ex;
    }
  }

  SObject queryAllAccessibleFields(String objectApiName, Id recordId, Schema.SObjectType objType) {
    Schema.DescribeSObjectResult objDescribe = objType.getDescribe();
    Set<String> allFields = new Set<String>();
    for (Schema.SObjectField f : objDescribe.fields.getMap().values()) {
      Schema.DescribeFieldResult dfr = f.getDescribe();
      if (dfr.isAccessible()) allFields.add(dfr.getName());
    }
    SObject record = fetcher.queryRecord(objectApiName, recordId, allFields, objType, objDescribe);
    return record != null ? record : objType.newSObject();
  }

  String wrapIdLiteralsWithCasting(String formulaExpression) {
    if (String.isBlank(formulaExpression)) return formulaExpression;
    Pattern idPattern = Pattern.compile('\\'([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})\\'');
    Matcher matcher = idPattern.matcher(formulaExpression);
    List<Map<String,Object>> replacements = new List<Map<String,Object>>();
    while (matcher.find()) {
      String idWithQuotes = matcher.group(0);
      String idValue = matcher.group(1);
      Integer matchStart = matcher.start();
      Integer matchEnd = matcher.end();
      Integer lookBehindStart = Math.max(0, matchStart - 12);
      String precedingText = formulaExpression.substring(lookBehindStart, matchStart);
      if (precedingText.endsWithIgnoreCase('CASESAFEID(')) continue;
      if (idValue.length() >= 15 && Pattern.matches('[a-zA-Z0-9]{3}[a-zA-Z0-9]{12,15}', idValue)) {
        String wrapped = 'CASESAFEID(\\'' + idValue + '\\')';
        replacements.add(new Map<String,Object>{ 'start' => matchStart, 'end' => matchEnd, 'original' => idWithQuotes, 'replacement' => wrapped });
      }
    }
    String result = formulaExpression;
    for (Integer i = replacements.size() - 1; i >= 0; i--) {
      Map<String,Object> replacement = replacements[i];
      Integer start = (Integer)replacement.get('start');
      Integer endPos = (Integer)replacement.get('end');
      String wrapped = (String)replacement.get('replacement');
      result = result.substring(0, start) + wrapped + result.substring(endPos);
    }
    return result;
  }

  String formatResult(Object result, String fieldDataType) {
    if (result == null) return String.valueOf(result);
    if (String.isNotBlank(fieldDataType) && fieldDataType.containsIgnoreCase('Percent') && result instanceof Decimal) {
      Decimal percentValue = ((Decimal) result) * 100;
      percentValue = percentValue.stripTrailingZeros();
      if (percentValue.scale() > 0) return percentValue.toPlainString();
      else return percentValue.intValue().toString();
    }
    if (result instanceof Decimal) {
      Decimal resultDecimal = (Decimal) result;
      resultDecimal = resultDecimal.stripTrailingZeros();
      if (resultDecimal.scale() > 0) return resultDecimal.toPlainString();
      else return resultDecimal.intValue().toString();
    }
    return String.valueOf(result);
  }
}
`;

// Escapes a JS string for embedding as an Apex string literal via apexStr, then
// wraps the whole anonymous block. Both blocks surface their output by throwing
// an exception whose message is RESULT_SENTINEL + <payload>, which
// executeAnonymous returns verbatim in `exceptionMessage`.

// Phase 2 — evaluate a (already client-substituted) expression. Inlines the
// five parameters as Apex literals and throws the formatted result string.
function buildEvaluateApex({expression, objectApiName, recordId, blankFieldHandling, fieldDataType}) {
  const recordIdApex = recordId ? apexStr(recordId) : "null";
  return APEX_FETCHER + APEX_EVALUATOR + `
String fpOut = new FpEval().evaluateFormula(${apexStr(expression)}, ${apexStr(objectApiName)}, ${recordIdApex}, ${apexStr(blankFieldHandling || "")}, ${apexStr(fieldDataType || "")});
FpResultException fpEx = new FpResultException(); fpEx.setMessage(${apexStr(RESULT_SENTINEL)} + fpOut); throw fpEx;
`;
}

// Phase 1 — fetch field values + types for the formula's references, and return
// them as JSON (nulls become the __NULL__ marker, exactly as the app's
// parseFormulaText does). Thrown as RESULT_SENTINEL + JSON.
function buildParseApex({formula, objectApiName, recordId}) {
  const recordIdApex = recordId ? apexStr(recordId) : "null";
  return APEX_FETCHER + `
FpFetchResult fpRes = new FpFetcher().fetchFieldData(${apexStr(formula)}, ${apexStr(objectApiName)}, ${recordIdApex});
Map<String,Object> fpClientValues = new Map<String,Object>();
for (String k : fpRes.fieldValues.keySet()) { Object v = fpRes.fieldValues.get(k); fpClientValues.put(k, v == null ? '${NULL_MARKER}' : v); }
Map<String,Object> fpPayload = new Map<String,Object>{ 'fieldValues' => fpClientValues, 'fieldTypes' => fpRes.fieldTypes };
FpResultException fpEx = new FpResultException(); fpEx.setMessage(${apexStr(RESULT_SENTINEL)} + JSON.serialize(fpPayload)); throw fpEx;
`;
}

/**
 * Run an anonymous-Apex body and return the payload it threw via RESULT_SENTINEL.
 * Throws an Error if the apex failed to compile or errored for real reasons.
 */
async function runAnonymousApex(apexBody) {
  // The Apex body embeds the app's whole FormulaDataFetcher + evaluator (~250
  // lines), which is far too long for the Tooling REST executeAnonymous (it
  // takes the code as a GET query param → HTTP 414/431). So we use the SOAP
  // Apex service instead, which carries the code in the request BODY (no URL
  // length limit). This reuses the Inspector's existing sfConn.soap layer.
  const wsdl = sfConn.wsdl(apiVersion, "Apex");
  // No DebuggingHeader needed — we read the result from our thrown exception's
  // message, not from a debug log.
  const res = await sfConn.soap(wsdl, "executeAnonymous", {String: apexBody});
  // res: {compiled, compileProblem, success, line, column, exceptionMessage, exceptionStackTrace}
  // XML parsing yields string booleans; normalize.
  const compiled = res.compiled === "true" || res.compiled === true;
  if (!compiled) {
    console.error("Formula Prettifier: Apex did not compile", {
      compileProblem: res.compileProblem, line: res.line, column: res.column, apexBody
    });
    throw new Error("Apex compile error: " + (res.compileProblem || "unknown"));
  }
  const msg = res.exceptionMessage || "";
  const idx = msg.indexOf(RESULT_SENTINEL);
  if (idx !== -1) {
    return msg.substring(idx + RESULT_SENTINEL.length);
  }
  // Ran but didn't reach our throw — a genuine runtime failure. Log the full
  // Apex response so the real cause is visible in the console.
  console.error("Formula Prettifier: Apex ran but returned no result", {
    success: res.success,
    exceptionMessage: res.exceptionMessage,
    exceptionStackTrace: res.exceptionStackTrace,
    apexBody
  });
  throw new Error("Apex execution error: " + (res.exceptionMessage || "no result"));
}

/**
 * Phase 1: fetch the formula's field values + types (once per formula).
 * Returns {fieldValues, fieldTypes} with nulls restored from the __NULL__ marker.
 */
export async function fetchFieldData(formula, objectApiName, recordId) {
  const payload = await runAnonymousApex(buildParseApex({formula, objectApiName, recordId}));
  const data = JSON.parse(payload);
  const fieldValues = {};
  const raw = data.fieldValues || {};
  for (const key of Object.keys(raw)) {
    fieldValues[key] = raw[key] === NULL_MARKER ? null : raw[key];
  }
  return {fieldValues, fieldTypes: data.fieldTypes || {}};
}

/**
 * Phase 2: evaluate an expression (already substituted via
 * replaceFieldsWithValues) and return the formatted result string.
 */
export async function evaluateExpression({expression, objectApiName, recordId, blankFieldHandling, fieldDataType}) {
  return runAnonymousApex(buildEvaluateApex({expression, objectApiName, recordId, blankFieldHandling, fieldDataType}));
}

/**
 * Whether the running user can run anonymous Apex (Author Apex permission).
 * Used to gate the evaluation UI. Cached after the first check.
 */
let canRunApexCache = null;
export async function canRunApex() {
  if (canRunApexCache !== null) return canRunApexCache;
  try {
    // A trivial no-op anonymous block via the SOAP Apex service. If the user
    // lacks the permission this throws; if allowed it compiles fine.
    const wsdl = sfConn.wsdl(apiVersion, "Apex");
    const res = await sfConn.soap(wsdl, "executeAnonymous", {String: "Integer fp = 1;"});
    canRunApexCache = res.compiled === "true" || res.compiled === true;
  } catch {
    canRunApexCache = false;
  }
  return canRunApexCache;
}
