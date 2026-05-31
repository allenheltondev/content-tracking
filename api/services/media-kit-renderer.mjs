// The HTML template is inlined into the bundle as a string by esbuild's
// `.html=text` loader (see template.yaml esbuild-properties). It contains a
// single __MEDIA_KIT_DATA__ token inside a <script type="application/json">
// tag; we swap that token for the snapshot's JSON so the resulting page is
// fully self-contained (no runtime API calls; the only external resources
// are the CloudFront-signed avatar/logo image URLs baked into the data).
import TEMPLATE from "../templates/media-kit.html";

const TOKEN = "__MEDIA_KIT_DATA__";

// Line/paragraph separators are valid in JSON but illegal raw inside a JS
// string literal in some parsers, so they are escaped too. Built with RegExp
// constructors to avoid placing the raw separator characters in source.
const LINE_SEP = new RegExp(" ", "g");
const PARA_SEP = new RegExp(" ", "g");

// Escape JSON so it can never break out of the <script> tag it is embedded
// in. `<` -> escaped neutralizes any `</script>` sequence in the data; the
// matching `>` and `&` escapes keep the payload HTML-inert.
function escapeForScript(json) {
  return json
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}

// The template ships with a noindex directive (private signed kits must
// never be indexed). The public teaser overrides this so the bio-link page
// can be found by search engines.
const NOINDEX_META = '<meta name="robots" content="noindex, nofollow">';
const INDEX_META = '<meta name="robots" content="index, follow">';

/**
 * Render a frozen media-kit snapshot into a complete, standalone HTML
 * document. Pure function: the only I/O is reading the bundled template at
 * module load. No network access.
 *
 * @param {object} snapshot - the media-kit snapshot (see data contract).
 * @param {object} [options]
 * @param {boolean} [options.indexable=false] - when true, emit an
 *   index/follow robots directive instead of the default noindex. Only the
 *   public teaser sets this; private signed kits stay noindex.
 * @returns {string} the full HTML document.
 */
export function renderMediaKitHtml(snapshot, { indexable = false } = {}) {
  const json = JSON.stringify(snapshot);
  const safe = escapeForScript(json);
  // Use a replacer function so `$` sequences in the data are not interpreted
  // as replacement patterns by String.prototype.replace.
  let html = TEMPLATE.replace(TOKEN, () => safe);
  if (indexable) {
    html = html.replace(NOINDEX_META, INDEX_META);
  }
  return html;
}
