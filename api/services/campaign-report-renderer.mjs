// The HTML template is inlined into the bundle as a string by esbuild's
// `.html=text` loader (see template.yaml esbuild-properties). It contains a
// single __REPORT_DATA__ token inside a <script type="application/json">
// tag; we swap that token for the snapshot's JSON so the resulting page is
// fully self-contained (no runtime API calls, no external resources).
import TEMPLATE from "../templates/campaign-report.html";

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
 * Render a frozen campaign report snapshot into a complete, standalone HTML
 * document. Pure function: the only I/O is reading the bundled template at
 * module load. No network access.
 *
 * @param {object} snapshot - the campaign report snapshot (see data contract).
 * @returns {string} the full HTML document.
 */
export function renderCampaignReportHtml(snapshot) {
  const json = JSON.stringify(snapshot);
  const safe = escapeForScript(json);
  // Use a replacer function so `$` sequences in the data are not interpreted
  // as replacement patterns by String.prototype.replace.
  return TEMPLATE.replace(TOKEN, () => safe);
}
