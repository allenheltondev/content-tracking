import { readFileSync } from "node:fs";

// The bundled HTML template is read once at module load. It contains a single
// __REPORT_DATA__ token inside a <script type="application/json"> tag; we swap
// that token for the snapshot's JSON so the resulting page is fully
// self-contained (no runtime API calls, no external resources).
const TEMPLATE = readFileSync(new URL("../templates/vendor-report.html", import.meta.url), "utf8");

const TOKEN = "__REPORT_DATA__";

// Line/paragraph separators are valid in JSON but illegal raw inside a JS
// string literal in some parsers, so they are escaped too. Built with RegExp
// constructors to avoid placing the raw separator characters in source.
const LINE_SEP = new RegExp(" ", "g");
const PARA_SEP = new RegExp(" ", "g");

// Escape JSON so it can never break out of the <script> tag it is embedded in.
// `<` -> `<` neutralizes any `</script>` sequence in the data; the
// matching `>` and `&` escapes keep the payload HTML-inert.
function escapeForScript(json) {
  return json
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}

/**
 * Render a frozen vendor report snapshot into a complete, standalone HTML
 * document. Pure function: the only I/O is reading the bundled template at
 * module load. No network access.
 *
 * @param {object} snapshot - the report snapshot (see data contract).
 * @returns {string} the full HTML document.
 */
export function renderVendorReportHtml(snapshot) {
  const json = JSON.stringify(snapshot);
  const safe = escapeForScript(json);
  // Use a replacer function so `$` sequences in the data are not interpreted
  // as replacement patterns by String.prototype.replace.
  return TEMPLATE.replace(TOKEN, () => safe);
}
