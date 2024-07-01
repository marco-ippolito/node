'use strict';
const fs = require('node:fs');
const path = require('node:path');

const base64 = fs.readFileSync(path.join(process.cwd(), 'deps/swc/wasm_bg.wasm')).toString('base64');

fs.writeFileSync(path.join(process.cwd(), 'deps/swc/wasm_bg.js'), `'use strict'
const { Buffer } = require('node:buffer')
module.exports = Buffer.from('${base64}', 'base64')
`);
