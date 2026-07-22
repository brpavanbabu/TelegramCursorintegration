'use strict';

/** Sentinel Test Framework — machine-readable JSON reporter. */

const fs = require('fs');
const path = require('path');

function write(fullReport, outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(fullReport, null, 2), 'utf8');
  return outFile;
}

module.exports = { write };
