/* HARNESS-ONLY stub for inspector.js so fpdev_eval_real_copy.js can load its pure
 * helper functions standalone (its network fns are never called in the harness). */
export const apiVersion = "62.0";
export const sfConn = {
  async rest() { throw new Error("harness: sfConn.rest not available"); },
  async soap() { throw new Error("harness: sfConn.soap not available"); },
  wsdl() { return {}; }
};
