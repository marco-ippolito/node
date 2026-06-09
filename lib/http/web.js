'use strict';

const { emitExperimentalWarning } = require('internal/util');

emitExperimentalWarning('http/web');

module.exports = require('internal/http_web_server');
