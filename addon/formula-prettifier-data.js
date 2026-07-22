/* Formula Prettifier — Salesforce data access.
 *
 * Client-side replacements for the Apex controller methods that fetched
 * metadata in the AppExchange app. A browser extension has no Apex, so these
 * use the standard sObject Describe and the Inspector's shared, cached sObject
 * list via sfConn / utils (inspector.js, utils.js).
 *
 *   Apex getObjectsWithFormulaFields()  ->  getObjectList() + getFormulaFieldsForObject()
 *   Apex getFieldFormula(obj, field)    ->  getFieldFormula()
 *
 * Note on strategy: Salesforce exposes no cheap, browser-queryable "objects
 * that have formula fields" signal (FieldDefinition can't be queried org-wide;
 * fetching every field's Metadata is far too slow). So the Object picker uses
 * the Inspector's standard cached full sObject list (getSobjectsList — per-org,
 * gzip-compressed, background-refreshed) presented as a searchable type-ahead,
 * and the actual *formula* fields for a chosen object are derived lazily from
 * that object's describe (fields[].calculatedFormula).
 */
import {sfConn, apiVersion} from "./inspector.js";
import {getSobjectsList} from "./utils.js";

/**
 * The full, cached list of sObjects for the Object picker. Reuses the
 * Inspector's shared getSobjectsList (cache-first, per-org, background-refresh)
 * rather than issuing our own metadata queries.
 *
 * @param {string} sfHost
 * @returns {Promise<Array<{label: string, value: string}>>}
 */
export async function getObjectList(sfHost) {
  const sobjects = await getSobjectsList(sfHost);
  return (sobjects || [])
    .filter(o => o && o.name)
    .map(o => ({
      label: (o.label && o.label !== o.name) ? o.label + " (" + o.name + ")" : o.name,
      value: o.name
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The formula fields of a single object, for the Field picker. Uses the
 * standard sObject describe (same path as the Inspector's existing Agentforce
 * Formula Helper): a field is a formula field iff it has a calculatedFormula.
 * This reliably excludes roll-up summaries, which report IsCalculated=true but
 * have no formula text.
 *
 * @param {string} objectApiName
 * @returns {Promise<Array<{label: string, value: string, dataType: string}>>}
 */
// Per-object describe cache. A single describe already contains every field's
// calculatedFormula, so listing an object's formula fields and then reading a
// chosen field's formula reuse the same cached describe instead of re-fetching.
// (In-memory only; the extension re-describes once per session per object.)
const describeCache = new Map();

function describeObject(objectApiName) {
  if (!describeCache.has(objectApiName)) {
    describeCache.set(objectApiName, sfConn.rest(
      "/services/data/v" + apiVersion + "/sobjects/" + encodeURIComponent(objectApiName) + "/describe/"
    ).catch(e => {
      // Don't cache a failure — allow a later retry.
      describeCache.delete(objectApiName);
      throw e;
    }));
  }
  return describeCache.get(objectApiName);
}

export async function getFormulaFieldsForObject(objectApiName) {
  if (!objectApiName) return [];
  const describe = await describeObject(objectApiName);
  const fields = (describe && describe.fields) || [];
  return fields
    .filter(f => f.calculatedFormula)
    .map(f => ({label: f.label || f.name, value: f.name, dataType: f.type || ""}))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The formula source text for a formula field, or "" if the field is not a
 * formula or has no accessible formula. Reuses the cached object describe.
 *
 * @param {string} objectApiName
 * @param {string} fieldApiName
 * @returns {Promise<string>}
 */
export async function getFieldFormula(objectApiName, fieldApiName) {
  if (!objectApiName || !fieldApiName) return "";
  const describe = await describeObject(objectApiName);
  const fields = (describe && describe.fields) || [];
  const field = fields.find(f => f.name === fieldApiName);
  if (!field) return "";
  return field.calculatedFormula || "";
}
