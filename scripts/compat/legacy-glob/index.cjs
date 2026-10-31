// Only temp -> rimraf uses this adapter. Matching and traversal stay owned by
// patched upstream glob; retain rimraf's callback, sync and hasMagic surface.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Legacy rimraf loads this adapter synchronously through CommonJS.
const modern = require('glob-modern');
const legacyOptions = options => ({ windowsPathsNoEscape: process.platform === 'win32', ...options });
function legacyGlob(pattern, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  const result = modern.glob(pattern, legacyOptions(options));
  if (typeof callback === 'function') {
    void result.then(files => callback(null, files), error => callback(error));
    return;
  }
  return result;
}
module.exports = Object.assign(legacyGlob, modern, {
  glob: legacyGlob,
  sync: (pattern, options) => modern.globSync(pattern, legacyOptions(options)),
  hasMagic: (pattern, options) => modern.hasMagic(pattern, legacyOptions(options)),
});
