// The matcher the page's preview runs: the same phrase handling the middleware
// uses, so "试运行" answers exactly what a request would get.
//
// magpie serves page files as classic scripts, so this file publishes one object
// on the global instead of exporting. test/middleware.test.mjs keeps it byte-for-
// byte in step with the middleware's output.

globalThis.PROMPT_GUARD_MATCH = (() => {
  const MAX_RULES = 50;
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const phrasePattern = (find) => find.trim().split(/\s+/).map(escapeRegExp).join("\\s+");

  /**
   * @param {Array<{on?: boolean, find?: string, replace?: string, mode?: string, flags?: string}>} rules
   * @returns {Array<{find: string, re: RegExp, replace: string}>}
   */
  function compile(rules) {
    const compiled = [];
    for (const rule of rules) {
      if (!rule || rule.on === false) continue;
      if (typeof rule.find !== "string" || !rule.find.trim()) continue;
      let re;
      try {
        re =
          rule.mode === "regex"
            ? new RegExp(rule.find, rule.flags || "gi")
            : new RegExp(phrasePattern(rule.find), "gi");
      } catch (error) {
        continue;
      }
      compiled.push({
        find: rule.find,
        re: re,
        replace: typeof rule.replace === "string" ? rule.replace : "",
      });
      if (compiled.length >= MAX_RULES) break;
    }
    return compiled;
  }

  /**
   * @param {string} text
   * @param {Array<{re: RegExp, replace: string}>} compiled
   * @returns {string}
   */
  function rewrite(text, compiled) {
    let out = text;
    for (const rule of compiled) out = out.replace(rule.re, () => rule.replace);
    return out;
  }

  /**
   * Rewrites one block of text and reports which rules changed it.
   * @param {string} text
   * @param {Array<{find: string, re: RegExp, replace: string}>} compiled
   * @returns {{out: string, hits: Array<{find: string, replace: string, count: number}>}}
   */
  function testText(text, compiled) {
    const hits = [];
    let out = text;
    for (const rule of compiled) {
      let count = 0;
      out = out.replace(rule.re, () => {
        count += 1;
        return rule.replace;
      });
      if (count > 0) hits.push({ find: rule.find, replace: rule.replace, count: count });
    }
    return { out: out, hits: hits };
  }

  return { compile: compile, rewrite: rewrite, testText: testText };
})();
