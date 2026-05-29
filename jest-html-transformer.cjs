// Jest transformer that mirrors esbuild's `.html=text` loader: imports of
// .html files resolve to the file's raw contents as a default-exported
// string. Keeps report-renderer.mjs identical in tests and in the bundled
// Lambda — see template.yaml esbuild-properties.Loader.
module.exports = {
  process(sourceText) {
    return { code: `module.exports = ${JSON.stringify(sourceText)};` };
  },
};
