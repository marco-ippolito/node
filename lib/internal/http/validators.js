'use strict';

const {
  RegExpPrototypeExec,
  StringPrototypeCharCodeAt,
  Uint8Array,
} = primordials;

const {
  codes: {
    ERR_HTTP_INVALID_HEADER_VALUE,
    ERR_HTTP_INVALID_STATUS_CODE,
    ERR_INVALID_CHAR,
    ERR_INVALID_HTTP_TOKEN,
  },
} = require('internal/errors');

// Character code ranges for HTTP tokens, per RFC 9110 section 5.6.2.
// Valid chars: ^_`a-zA-Z-0-9!#$%&'*+.|~
const tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const validTokenChars = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0-15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16-31
  0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, // 32-47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48-63
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64-79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, // 80-95
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96-111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, // 112-127
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 128-143
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 144-159
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 160-175
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 176-191
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 192-207
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 208-223
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 224-239
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 240-255
]);

const strictHeaderCharRegExp = /[^\t\x20-\x7e\x80-\xff]/;

function checkIsHttpToken(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  if (value.length >= 10) {
    return RegExpPrototypeExec(tokenRegExp, value) !== null;
  }

  for (let i = 0; i < value.length; i++) {
    if (!validTokenChars[StringPrototypeCharCodeAt(value, i)]) {
      return false;
    }
  }
  return true;
}

function checkInvalidHeaderChar(value) {
  return RegExpPrototypeExec(strictHeaderCharRegExp, value) !== null;
}

function validateHeaderName(name, label = 'Header name') {
  if (!checkIsHttpToken(name)) {
    throw new ERR_INVALID_HTTP_TOKEN.HideStackFramesError(label, name);
  }
}

function validateHeaderValue(name, value) {
  if (value === undefined) {
    throw new ERR_HTTP_INVALID_HEADER_VALUE.HideStackFramesError(value, name);
  }
  if (checkInvalidHeaderChar(value)) {
    throw new ERR_INVALID_CHAR.HideStackFramesError('header content', name);
  }
}

function validateStatusCode(statusCode) {
  const originalStatusCode = statusCode;
  statusCode |= 0;
  if (statusCode < 100 || statusCode > 999) {
    throw new ERR_HTTP_INVALID_STATUS_CODE(originalStatusCode);
  }
  return statusCode;
}

module.exports = {
  checkInvalidHeaderChar,
  checkIsHttpToken,
  validateHeaderName,
  validateHeaderValue,
  validateStatusCode,
};
