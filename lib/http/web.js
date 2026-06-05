'use strict';

const {
  emitExperimentalWarning,
} = require('internal/util');
const {
  createServer,
} = require('internal/http_web_server');

emitExperimentalWarning('Web HTTP server');

module.exports = {
  createServer,
};
