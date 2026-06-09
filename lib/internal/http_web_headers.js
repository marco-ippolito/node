'use strict';

// Shared, HTTP-version-agnostic header and status helpers for node:http/web.
//
// Everything here is pure (no module-level mutable state) and applies equally
// to HTTP/1.1, HTTP/2, and HTTP/3: header-token validation, header value
// validation, response-header normalization, the flat alternating header
// storage shared with the parser, status-code semantics, and the no-body
// status policy. HTTP-version-specific wire serialization (status lines,
// chunked framing, the Date/keep-alive caches) lives in the protocol layer,
// not here.

const {
  ArrayIsArray,
  ArrayPrototypePush,
  NumberIsInteger,
  ObjectFreeze,
  ObjectKeys,
  StringPrototypeCharCodeAt,
  SymbolAsyncIterator,
  SymbolIterator,
} = primordials;

const {
  codes: {
    ERR_HTTP_INVALID_HEADER_VALUE,
    ERR_HTTP_INVALID_STATUS_CODE,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_CHAR,
    ERR_INVALID_HTTP_TOKEN,
  },
} = require('internal/errors');
const {
  validateObject,
} = require('internal/validators');

const kHeaderName = 'Header name';

// IANA HTTP status code reason phrases. Status semantics are version-agnostic;
// only how a status is serialized onto the wire differs per HTTP version.
const kStatusText = {
  __proto__: null,
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  510: 'Not Extended',
  511: 'Network Authentication Required',
};

// RFC 7230 section 3.3: 1xx, 204, and 304 responses must not include a
// message body. This is a protocol-level rule that holds across HTTP versions.
function isForbiddenBodyStatus(status) {
  return (status >= 100 && status < 200) || status === 204 || status === 304;
}

function validateStatus(status) {
  if (!NumberIsInteger(status) || status < 100 || status > 999) {
    throw new ERR_HTTP_INVALID_STATUS_CODE(status);
  }
}

// Like legacy IncomingMessage.rawHeaders, parsed request headers are stored as
// a flat alternating list:
//   [name, value, name, value, ...]
// The pair-array shape required by ctx.request and hijack().headers is
// materialized lazily. Response headers use the same flat storage after
// validation so serialization can walk one compact array.
function isHeaderToken(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const ch = StringPrototypeCharCodeAt(value, i);
    if (ch >= 0x30 && ch <= 0x39) continue;  // 0-9
    if (ch >= 0x41 && ch <= 0x5a) continue;  // A-Z
    if (ch >= 0x61 && ch <= 0x7a) continue;  // a-z
    switch (ch) {
      case 0x21:  // !
      case 0x23:  // #
      case 0x24:  // $
      case 0x25:  // %
      case 0x26:  // &
      case 0x27:  // '
      case 0x2a:  // *
      case 0x2b:  // +
      case 0x2d:  // -
      case 0x2e:  // .
      case 0x2f:  // /
      case 0x3d:  // =
      case 0x3f:  // ?
      case 0x5e:  // ^
      case 0x5f:  // _
      case 0x60:  // `
      case 0x7b:  // {
      case 0x7c:  // |
      case 0x7d:  // }
      case 0x7e:  // ~
        continue;
      default:
        return false;
    }
  }
  return true;
}

function hasInvalidHeaderValueChar(value) {
  for (let i = 0; i < value.length; i++) {
    const ch = StringPrototypeCharCodeAt(value, i);
    if (ch === 0x09) continue;
    if (ch >= 0x20 && ch <= 0x7e) continue;
    if (ch >= 0x80 && ch <= 0xff) continue;
    return true;
  }
  return false;
}

function appendHeaderPair(out, name, value) {
  if (!isHeaderToken(name)) {
    throw new ERR_INVALID_HTTP_TOKEN(kHeaderName, name);
  }

  switch (typeof value) {
    case 'string':
      break;
    case 'number':
    case 'bigint':
    case 'boolean':
      value = `${value}`;
      break;
    case 'undefined':
      throw new ERR_HTTP_INVALID_HEADER_VALUE(value, name);
    default:
      throw new ERR_INVALID_ARG_TYPE(
        `headers.${name}`, ['string', 'number', 'bigint', 'boolean'], value);
  }

  if (hasInvalidHeaderValueChar(value)) {
    throw new ERR_INVALID_CHAR('header content', name);
  }

  ArrayPrototypePush(out, name, value);
}

function normalizeResponseHeaders(headers) {
  if (headers === undefined) return [];

  if (ArrayIsArray(headers)) {
    const out = [];
    if (headers.length === 0) return out;
    if (!ArrayIsArray(headers[0])) {
      if (headers.length % 2 !== 0) {
        throw new ERR_INVALID_ARG_VALUE('headers', headers);
      }
      for (let i = 0; i < headers.length; i += 2) {
        appendHeaderPair(out, headers[i], headers[i + 1]);
      }
      return out;
    }
    for (let i = 0; i < headers.length; i++) {
      const entry = headers[i];
      if (!ArrayIsArray(entry) || entry.length !== 2) {
        throw new ERR_INVALID_ARG_VALUE('headers', headers);
      }
      appendHeaderPair(out, entry[0], entry[1]);
    }
    return out;
  }

  if (headers && typeof headers[SymbolAsyncIterator] !== 'function' &&
      typeof headers[SymbolIterator] === 'function') {
    const out = [];
    for (const entry of headers) {
      if (!ArrayIsArray(entry) || entry.length !== 2) {
        throw new ERR_INVALID_ARG_VALUE('headers', headers);
      }
      appendHeaderPair(out, entry[0], entry[1]);
    }
    return out;
  }

  validateObject(headers, 'headers');
  const names = ObjectKeys(headers);
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const value = headers[name];
    if (ArrayIsArray(value)) {
      for (let j = 0; j < value.length; j++) {
        appendHeaderPair(out, name, value[j]);
      }
    } else {
      appendHeaderPair(out, name, value);
    }
  }
  return out;
}

// Case-insensitive comparison of a header name against an expected lowercase
// token. Used for cheap policy lookups without lowercasing every header.
function headerNameEquals(value, expected) {
  if (value.length !== expected.length) return false;
  for (let i = 0; i < value.length; i++) {
    let ch = StringPrototypeCharCodeAt(value, i);
    if (ch >= 0x41 && ch <= 0x5a) ch |= 0x20;
    if (ch !== StringPrototypeCharCodeAt(expected, i)) return false;
  }
  return true;
}

// Find the last value for a header name in a flat [name, value, ...] list.
function findHeader(headers, name) {
  for (let i = headers.length - 2; i >= 0; i -= 2) {
    if (headerNameEquals(headers[i], name)) {
      return headers[i + 1];
    }
  }
}

// Materialize a flat [name, value, ...] list into [[name, value], ...] pairs
// for Web-facing surfaces (ctx.request, hijack().headers, inject responses).
function materializeFlatHeaderPairs(rawHeaders) {
  const headers = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    ArrayPrototypePush(headers, [rawHeaders[i], rawHeaders[i + 1]]);
  }
  return headers;
}

function getRequestHeaders(record) {
  if (record.headers !== undefined) return record.headers;
  return record.headers = materializeFlatHeaderPairs(record.rawHeaders);
}

module.exports = ObjectFreeze({
  appendHeaderPair,
  findHeader,
  getRequestHeaders,
  hasInvalidHeaderValueChar,
  isForbiddenBodyStatus,
  isHeaderToken,
  kStatusText,
  materializeFlatHeaderPairs,
  normalizeResponseHeaders,
  validateStatus,
});
