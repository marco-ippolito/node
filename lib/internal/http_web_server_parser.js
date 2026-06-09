'use strict';

const {
  ArrayPrototypePush,
  BigInt,
  ObjectFreeze,
  StringPrototypeCharCodeAt,
  StringPrototypeIndexOf,
  StringPrototypeLastIndexOf,
  StringPrototypeSlice,
  StringPrototypeToLowerCase,
} = primordials;

const { Buffer } = require('buffer');

const kStatusBadRequest = 400;
const kStatusPayloadTooLarge = 413;
const kStatusExpectationFailed = 417;
const kStatusNotImplemented = 501;
const kStatusRequestHeaderFieldsTooLarge = 431;
const kEmpty = Buffer.alloc(0);
const kCR = 0x0d;
const kLF = 0x0a;
const kSlash = 0x2f;       // '/'
const kHeaderTerminatorLength = 4;
// Size of the reusable global WASM parse slab. 64 KiB covers virtually all
// requests (header-only GETs are ~100-300 bytes; the slab is only needed for
// the combined prefix+input, not the full body). Requests larger than this
// fall back to a dynamic allocation.
const kParseSlabSize = 65536;
// Single global WASM parse buffer shared across all parser instances.
// Safe because JavaScript is single-threaded: two parse() calls can never
// overlap. Body chunks that reference body-input (the original libuv read
// buffer) are views into that buffer, NOT into the slab. Body chunks that
// span the prefix/input boundary are copied via Buffer.from() before the
// finally block clears this.#input, so no slab reference escapes.
let parseSlabPtr = 0;

let milo;

// The parser whose parse() call is currently executing. Milo registers its
// callbacks once, globally, on the shared wasm instance, so each callback must
// find the owning MiloRequestParser. parse() is synchronous and JavaScript is
// single-threaded, so exactly one parser is ever active during a callback;
// routing through this module-level reference removes a SafeMap lookup (and an
// optional-chain) from every callback on the hot path (method, url, each header
// name/value, headers, data, message-complete -> ~12 per request).
let activeParser = null;

function lazyMilo() {
  if (milo !== undefined) return milo;
  const { setup } = require('internal/deps/milo/src/simd/index');
  milo = setup({
    __proto__: null,
    on_message_start() {
      activeParser.onMessageStart();
    },
    on_method(parser, at, size) {
      activeParser.onMethod(at, size);
    },
    on_url(parser, at, size) {
      activeParser.onURL(at, size);
    },
    on_header_name(parser, at, size) {
      activeParser.onHeaderName(at, size);
    },
    on_header_value(parser, at, size) {
      activeParser.onHeaderValue(at, size);
    },
    on_headers(parser, at, size) {
      activeParser.onHeaders(at, size);
    },
    on_data(parser, at, size) {
      activeParser.onData(at, size);
    },
    on_message_complete(parser, at, size) {
      activeParser.onMessageComplete(at, size);
    },
    on_error() {
      activeParser.onError();
    },
  });
  return milo;
}

// Case-insensitive comparison of buffer bytes [at, at + size) against a
// lowercase ASCII token. Operates directly on bytes so header-name policy
// checks (Host, Expect, Upgrade, Transfer-Encoding) need no string allocation.
function bytesEqualLower(buf, at, size, lower) {
  if (size !== lower.length) return false;
  for (let i = 0; i < size; i++) {
    let ch = buf[at + i];
    if (ch >= 0x41 && ch <= 0x5a) ch |= 0x20;
    if (ch !== StringPrototypeCharCodeAt(lower, i)) return false;
  }
  return true;
}

// Decode a flat [name, value, ...] header list from offset quadruples
// (nameAt, nameSize, valueAt, valueSize) into `bytes`. Shared by the lazy
// record getter and the eager absolute-form path.
function decodeRawHeaders(bytes, offsets) {
  const out = [];
  for (let i = 0; i < offsets.length; i += 4) {
    ArrayPrototypePush(
      out,
      bytes.toString('latin1', offsets[i], offsets[i] + offsets[i + 1]),
      bytes.toString('latin1', offsets[i + 2], offsets[i + 2] + offsets[i + 3]));
  }
  return out;
}

// Parse an absolute-form request-target (RFC 9112 section 3.2.2), e.g.
// "http://host:port/path?query". Returns { host, target } where `target` is the
// origin-form path+query and `host` is the authority (RFC: the authority
// overrides any Host header). Returns null when the target is not a valid
// http(s) absolute-form. Only invoked on the rare non-origin-form path.
function parseAbsoluteForm(target) {
  const schemeEnd = StringPrototypeIndexOf(target, '://');
  if (schemeEnd <= 0) return null;
  const scheme = StringPrototypeToLowerCase(
    StringPrototypeSlice(target, 0, schemeEnd));
  if (scheme !== 'http' && scheme !== 'https') return null;
  const rest = StringPrototypeSlice(target, schemeEnd + 3);
  let authEnd = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = StringPrototypeCharCodeAt(rest, i);
    if (c === kSlash || c === 0x3f || c === 0x23) {  // '/' '?' '#'
      authEnd = i;
      break;
    }
  }
  const authority = StringPrototypeSlice(rest, 0, authEnd);
  if (authority.length === 0) return null;
  // Strip any userinfo ("user@host"); the authority's host[:port] is what
  // becomes the request host.
  const at = StringPrototypeLastIndexOf(authority, '@');
  const host = at === -1 ? authority : StringPrototypeSlice(authority, at + 1);
  if (host.length === 0) return null;
  let path = StringPrototypeSlice(rest, authEnd);
  const hash = StringPrototypeIndexOf(path, '#');
  if (hash !== -1) path = StringPrototypeSlice(path, 0, hash);
  if (path.length === 0 || StringPrototypeCharCodeAt(path, 0) !== kSlash) {
    path = `/${path}`;
  }
  return { __proto__: null, host, target: path };
}

// Validate header-value bytes in place: HT, visible ASCII, and obs-text
// (0x80-0xFF) are allowed; anything else (CR, LF, other controls) is rejected.
// Validating bytes avoids allocating a string just to scan it.
function hasInvalidHeaderValueByte(buf, at, size) {
  for (let i = 0; i < size; i++) {
    const ch = buf[at + i];
    if (ch === 0x09) continue;
    if (ch >= 0x20 && ch <= 0x7e) continue;
    if (ch >= 0x80 && ch <= 0xff) continue;
    return true;
  }
  return false;
}

// A parsed request whose metadata strings are decoded lazily. Milo reports
// token spans as offsets into the parse buffer; we keep those offsets plus a
// reference to the backing bytes and only materialize method/url/host/header
// strings when user code reads them. Handlers that never touch request
// metadata (the common hijack fast path) pay nothing for decoding.
//
// `metaBytes` is either the original libuv read Buffer (when the whole request
// arrived in one read, so offsets index it directly and nothing is copied) or
// a small request-owned copy of the header region (when a token was split
// across reads). Either way it outlives the reused wasm slab, so lazy decoding
// is safe across subsequent parses and async handlers.
class LazyRecord {
  #bytes;
  #methodAt; #methodSize;
  #urlAt; #urlSize;
  #hostAt; #hostSize;
  #headerOffsets;
  #method; #url; #host; #rawHeaders;

  // Public fields read by the orchestration layer. `headers` and `bodySource`
  // are added lazily only if user code asks for those views; the rest are
  // populated eagerly during parsing.
  body;
  bodyLength;
  closeAfterResponse;

  constructor(bytes, methodAt, methodSize, urlAt, urlSize, hostAt, hostSize,
              headerOffsets, body, bodyLength, closeAfterResponse) {
    this.#bytes = bytes;
    this.#methodAt = methodAt;
    this.#methodSize = methodSize;
    this.#urlAt = urlAt;
    this.#urlSize = urlSize;
    this.#hostAt = hostAt;
    this.#hostSize = hostSize;
    this.#headerOffsets = headerOffsets;
    this.body = body;
    this.bodyLength = bodyLength;
    this.closeAfterResponse = closeAfterResponse;
  }

  // Build a record from already-decoded strings. Used when a request's headers
  // span multiple reads: the parse buffer is reused between reads, so offsets
  // captured in an earlier read are no longer valid and the metadata must be
  // decoded eagerly instead. Pre-filling the cache fields makes every getter
  // return immediately without touching offsets.
  static eager(method, url, host, rawHeaders, body, bodyLength,
               closeAfterResponse) {
    const r = new LazyRecord(
      null, 0, 0, 0, 0, -1, 0, null, body, bodyLength, closeAfterResponse);
    r.#method = method;
    r.#url = url;
    r.#host = host;
    r.#rawHeaders = rawHeaders;
    return r;
  }

  get method() {
    if (this.#method === undefined) {
      this.#method = this.#bytes.toString(
        'latin1', this.#methodAt, this.#methodAt + this.#methodSize);
    }
    return this.#method;
  }

  get url() {
    if (this.#url === undefined) {
      this.#url = this.#bytes.toString(
        'latin1', this.#urlAt, this.#urlAt + this.#urlSize);
    }
    return this.#url;
  }

  get host() {
    if (this.#host === undefined) {
      this.#host = this.#bytes.toString(
        'latin1', this.#hostAt, this.#hostAt + this.#hostSize);
    }
    return this.#host;
  }

  // Flat [name, value, name, value, ...] like legacy rawHeaders, decoded once
  // on first access from the stored offset quadruples.
  get rawHeaders() {
    if (this.#rawHeaders === undefined) {
      this.#rawHeaders = decodeRawHeaders(this.#bytes, this.#headerOffsets);
    }
    return this.#rawHeaders;
  }
}

// Sentinel used by Buffer.indexOf for the \r\n\r\n pattern.
const kHeaderTerminator = Buffer.from('\r\n\r\n');

function findHeaderTerminator(prefix, input) {
  const prefixLength = prefix.length;

  // Fast path: terminator is entirely within prefix.
  if (prefixLength >= kHeaderTerminatorLength) {
    const idx = prefix.indexOf(kHeaderTerminator);
    if (idx !== -1) return idx + kHeaderTerminatorLength;
  }

  // Scan positions where the terminator straddles the prefix/input boundary
  // (starts in prefix, ends in input). At most kHeaderTerminatorLength - 1 = 3
  // such positions exist.
  const windowStart = prefixLength >= (kHeaderTerminatorLength - 1) ?
    prefixLength - (kHeaderTerminatorLength - 1) :
    0;
  for (let i = windowStart; i < prefixLength; i++) {
    if (prefixLength + input.length - i < kHeaderTerminatorLength) break;
    const b0 = prefix[i];
    const b1 = i + 1 < prefixLength ? prefix[i + 1] : input[i + 1 - prefixLength];
    const b2 = i + 2 < prefixLength ? prefix[i + 2] : input[i + 2 - prefixLength];
    const b3 = i + 3 < prefixLength ? prefix[i + 3] : input[i + 3 - prefixLength];
    if (b0 === kCR && b1 === kLF && b2 === kCR && b3 === kLF) {
      return i + kHeaderTerminatorLength;
    }
  }

  // Fast path: terminator is entirely within input.
  if (input.length >= kHeaderTerminatorLength) {
    const idx = input.indexOf(kHeaderTerminator);
    if (idx !== -1) return prefixLength + idx + kHeaderTerminatorLength;
  }

  return -1;
}

class MiloRequestParser {
  #options;
  #bodyLimitBigInt;
  #parser;
  #input;
  #bodyInput;
  #prefixLength = 0;
  #records;
  #headersComplete;
  #waitingForHeaders = true;
  #sawHeaders = false;
  #headersEnd = 0;
  #headersInCurrentInput = false;
  #hasChunkedTransferEncoding = false;
  #errorStatus = 0;

  // Per-message metadata collected as offsets (no string decoding). Reset on
  // each on_message_start. Offsets are absolute into the current parse buffer
  // (this.#input); they are rebased onto request-owned bytes in #finishRecord.
  #inMessage = false;
  #methodAt = 0; #methodSize = 0;
  #urlAt = 0; #urlSize = 0;
  #hostAt = -1; #hostSize = 0; #hostCount = 0;
  // Expect handling: `Expect: 100-continue` is honored (the transport sends an
  // interim 100 response once headers are parsed); any other expectation is
  // rejected with 417. #needsContinue is the once-per-request signal returned
  // to the transport in the parse result.
  #expectContinue = false;
  #expectInvalid = false;
  #needsContinue = false;
  #hasUpgrade = false;
  #hasConnectionClose = false;
  #headerOffsets;
  #pendingNameAt = 0; #pendingNameSize = 0;
  #body;
  #bodyLength = 0;

  // Eager fallback: set when a message's headers span more than one read, so
  // offsets into the reused parse buffer can no longer be trusted. Once eager,
  // method/url/host/headers are decoded to strings as they arrive.
  #eager = false;
  #eagerMethod = '';
  #eagerUrl = '';
  #eagerHost = '';
  #eagerRawHeaders;

  constructor(options) {
    this.#options = options;
    this.#bodyLimitBigInt = BigInt(options.bodyLimit);

    const m = lazyMilo();
    const parser = m.create();
    this.#parser = parser;
    // Configure milo as a strict HTTP/1.1 request parser. It rejects other
    // versions (HTTP/1.0, 0.9, 1.2, 2.0) itself by firing on_error, so the
    // wrapper needs no explicit version guard; onError() maps that to 400.
    m.setIsRequest(parser, true);
    m.setShouldAutodetect(parser, false);
    m.setShouldManageUnconsumed(parser, false);
    m.setMaxHeaderLength(parser, options.maxHeaderSize);
    m.setMaxStartLineLength(parser, options.maxHeaderSize);
    m.setActiveCallbacks(
      parser,
      m.CALLBACK_ACTIVE_ON_ERROR |
        m.CALLBACK_ACTIVE_ON_MESSAGE_START |
        m.CALLBACK_ACTIVE_ON_MESSAGE_COMPLETE |
        m.CALLBACK_ACTIVE_ON_METHOD |
        m.CALLBACK_ACTIVE_ON_URL |
        m.CALLBACK_ACTIVE_ON_HEADER_NAME |
        m.CALLBACK_ACTIVE_ON_HEADER_VALUE |
        m.CALLBACK_ACTIVE_ON_HEADERS |
        m.CALLBACK_ACTIVE_ON_DATA);
  }

  parse(input, prefix = kEmpty) {
    this.#records = [];
    this.#headersComplete = false;
    this.#headersInCurrentInput = false;
    const prefixLength = prefix.length;
    const inputLength = input.length;
    const totalLength = prefixLength + inputLength;
    if (this.#waitingForHeaders && this.#options.maxHeaderSize !== 0) {
      const headerEnd = findHeaderTerminator(prefix, input);
      if ((headerEnd === -1 && totalLength > this.#options.maxHeaderSize) ||
          headerEnd > this.#options.maxHeaderSize) {
        return {
          __proto__: null,
          consumed: totalLength,
          errorStatus: kStatusRequestHeaderFieldsTooLarge,
          headersComplete: false,
          expectContinue: false,
          records: this.#records,
        };
      }
    }
    if (totalLength === 0) {
      return {
        __proto__: null,
        consumed: 0,
        errorStatus: this.#errorStatus,
        headersComplete: false,
        expectContinue: false,
        records: this.#records,
      };
    }

    const m = lazyMilo();
    // Use the global reusable slab when the parse input fits; otherwise fall
    // back to a dynamic allocation. The slab is never freed.
    let ptr;
    let dynamicAlloc = false;
    if (totalLength <= kParseSlabSize) {
      if (parseSlabPtr === 0) parseSlabPtr = m.alloc(kParseSlabSize);
      ptr = parseSlabPtr;
    } else {
      ptr = m.alloc(totalLength);
      dynamicAlloc = true;
    }
    const view = Buffer.from(m.memory.buffer, ptr, totalLength);
    if (prefixLength !== 0) view.set(prefix, 0);
    view.set(input, prefixLength);

    this.#input = view;
    this.#bodyInput = input;
    this.#prefixLength = prefixLength;
    // Route milo's global callbacks to this instance for the duration of the
    // synchronous parse. Restored in finally so a throwing callback cannot
    // leave a stale reference.
    activeParser = this;
    let consumed = 0;
    try {
      consumed = m.parse(this.#parser, ptr, totalLength);
      // If a request is still in progress, its headers span this read and the
      // next. Snapshot the captured metadata to strings now, while the parse
      // buffer is still valid, before it is reused for the next read.
      if (this.#inMessage && !this.#eager) this.#snapshotPartial();
    } finally {
      this.#input = undefined;
      this.#bodyInput = undefined;
      this.#prefixLength = 0;
      activeParser = null;
      if (dynamicAlloc) m.dealloc(ptr, totalLength);
    }

    // Report (and clear) the 100-continue signal. Only meaningful when the
    // body is still pending (no record produced this parse); if the body
    // already arrived with the headers there is nothing to wait for.
    const expectContinue = this.#needsContinue && this.#records.length === 0;
    this.#needsContinue = false;

    return {
      __proto__: null,
      consumed,
      errorStatus: this.#errorStatus,
      headersComplete: this.#headersComplete,
      expectContinue,
      records: this.#records,
    };
  }

  #finishRecord() {
    if (!this.#inMessage) {
      return {
        __proto__: null,
        errorStatus: kStatusBadRequest,
        record: undefined,
      };
    }

    const input = this.#input;
    const eager = this.#eager;

    // Classify the request-target. Origin-form ("/path") is the common case and
    // is recognized by its first byte with no string decoding. Anything else is
    // rare, so decoding the target there to classify it is acceptable.
    const urlFirstByte = eager ?
      (this.#eagerUrl.length === 0 ? 0 : StringPrototypeCharCodeAt(this.#eagerUrl, 0)) :
      input[this.#urlAt];

    let absoluteForm;
    if (urlFirstByte !== kSlash) {
      const url = eager ?
        this.#eagerUrl :
        input.toString('latin1', this.#urlAt, this.#urlAt + this.#urlSize);
      const method = eager ?
        this.#eagerMethod :
        input.toString('latin1', this.#methodAt, this.#methodAt + this.#methodSize);
      // asterisk-form: OPTIONS * is valid (RFC 9112 section 3.2.4) but deferred
      // in v1; 501 distinguishes unsupported-but-valid from malformed.
      if (url === '*' && method === 'OPTIONS') {
        return {
          __proto__: null,
          errorStatus: kStatusNotImplemented,
          record: undefined,
        };
      }
      // absolute-form (RFC 9112 section 3.2.2): a server MUST accept it. Extract
      // the origin-form target and the authority (which overrides Host below).
      absoluteForm = parseAbsoluteForm(url);
      if (absoluteForm === null) {
        return {
          __proto__: null,
          errorStatus: kStatusBadRequest,
          record: undefined,
        };
      }
    }

    // Host policy applies to origin-form only. For absolute-form the request
    // host comes from the request-target authority and any Host header is
    // ignored (RFC 9112 section 3.2.2).
    if (absoluteForm === undefined) {
      const hostEmpty = eager ? this.#eagerHost === '' : this.#hostSize === 0;
      if (this.#hostCount !== 1 || hostEmpty) {
        return {
          __proto__: null,
          errorStatus: kStatusBadRequest,
          record: undefined,
        };
      }
    }

    if (this.#bodyLength > this.#options.bodyLimit) {
      return {
        __proto__: null,
        errorStatus: kStatusPayloadTooLarge,
        record: undefined,
      };
    }

    // Milo state queries after cheap checks pass.
    const m = lazyMilo();
    if (m.hasTrailers(this.#parser)) {
      return {
        __proto__: null,
        errorStatus: kStatusNotImplemented,
        record: undefined,
      };
    }

    if (this.#hasUpgrade || m.hasUpgrade(this.#parser) ||
        m.hasConnectionUpgrade(this.#parser)) {
      return {
        __proto__: null,
        errorStatus: kStatusNotImplemented,
        record: undefined,
      };
    }

    const close = this.#hasConnectionClose || m.hasConnectionClose(this.#parser);
    const body = this.#body;
    let record;
    if (absoluteForm !== undefined) {
      // Rare absolute-form path: decode metadata eagerly and use the rewritten
      // origin-form target plus the authority as host.
      const method = eager ?
        this.#eagerMethod :
        input.toString('latin1', this.#methodAt, this.#methodAt + this.#methodSize);
      const rawHeaders = eager ?
        this.#eagerRawHeaders :
        decodeRawHeaders(input, this.#headerOffsets);
      record = LazyRecord.eager(
        method, absoluteForm.target, absoluteForm.host,
        rawHeaders, body, this.#bodyLength, close);
    } else if (eager) {
      // Headers spanned multiple reads; metadata is already decoded.
      record = LazyRecord.eager(
        this.#eagerMethod, this.#eagerUrl, this.#eagerHost,
        this.#eagerRawHeaders, body, this.#bodyLength, close);
    } else {
      // Common path: decode lazily from request-owned bytes. When the whole
      // request arrived in one read (no prefix), milo's offsets index the
      // original libuv read Buffer directly, so nothing is copied. Otherwise a
      // token was split within this single read; copy the small header region
      // out of the reused slab so the offsets stay valid after this parse.
      const metaBytes = this.#prefixLength === 0 ?
        this.#bodyInput :
        Buffer.from(input.subarray(0, this.#headersEnd));
      record = new LazyRecord(
        metaBytes,
        this.#methodAt, this.#methodSize,
        this.#urlAt, this.#urlSize,
        this.#hostAt, this.#hostSize,
        this.#headerOffsets,
        body,
        this.#bodyLength,
        close);
    }
    return {
      __proto__: null,
      errorStatus: 0,
      record,
    };
  }

  destroy() {
    const m = lazyMilo();
    m.destroy(this.#parser);
  }

  onMessageStart() {
    this.#waitingForHeaders = true;
    this.#inMessage = true;
    this.#methodAt = 0;
    this.#methodSize = 0;
    this.#urlAt = 0;
    this.#urlSize = 0;
    this.#hostAt = -1;
    this.#hostSize = 0;
    this.#hostCount = 0;
    this.#expectContinue = false;
    this.#expectInvalid = false;
    this.#needsContinue = false;
    this.#hasUpgrade = false;
    this.#hasConnectionClose = false;
    this.#headerOffsets = [];
    this.#pendingNameAt = 0;
    this.#pendingNameSize = 0;
    this.#body = [];
    this.#bodyLength = 0;
    this.#headersComplete = false;
    this.#sawHeaders = false;
    this.#headersEnd = 0;
    this.#hasChunkedTransferEncoding = false;
    this.#errorStatus = 0;
    this.#eager = false;
    this.#eagerMethod = '';
    this.#eagerUrl = '';
    this.#eagerHost = '';
    this.#eagerRawHeaders = null;
  }

  onMethod(at, size) {
    this.#ensure();
    if (this.#eager) {
      this.#eagerMethod = this.#input.toString('latin1', at, at + size);
      return;
    }
    this.#methodAt = at;
    this.#methodSize = size;
  }

  onURL(at, size) {
    this.#ensure();
    if (this.#eager) {
      this.#eagerUrl = this.#input.toString('latin1', at, at + size);
      return;
    }
    this.#urlAt = at;
    this.#urlSize = size;
  }

  onHeaderName(at, size) {
    this.#pendingNameAt = at;
    this.#pendingNameSize = size;
  }

  onHeaderValue(at, size) {
    const input = this.#input;
    const nameAt = this.#pendingNameAt;
    const nameSize = this.#pendingNameSize;
    if (nameSize === 0) {
      this.#errorStatus = kStatusBadRequest;
      const m = lazyMilo();
      m.fail(this.#parser, m.ERROR_USER, 'Missing header name');
      return;
    }
    if (hasInvalidHeaderValueByte(input, at, size)) {
      this.#errorStatus = kStatusBadRequest;
      const m = lazyMilo();
      m.fail(this.#parser, m.ERROR_USER, 'Invalid header value');
      return;
    }
    this.#ensure();
    // Cheap policy detection on header-name bytes; no string allocation.
    const isHost = bytesEqualLower(input, nameAt, nameSize, 'host');
    if (isHost) {
      this.#hostCount++;
    } else if (bytesEqualLower(input, nameAt, nameSize, 'expect')) {
      if (bytesEqualLower(input, at, size, '100-continue')) {
        this.#expectContinue = true;
      } else {
        this.#expectInvalid = true;
      }
    } else if (bytesEqualLower(input, nameAt, nameSize, 'connection')) {
      if (bytesEqualLower(input, at, size, 'close')) {
        this.#hasConnectionClose = true;
      }
    } else if (bytesEqualLower(input, nameAt, nameSize, 'upgrade')) {
      this.#hasUpgrade = true;
    } else if (bytesEqualLower(input, nameAt, nameSize, 'transfer-encoding') &&
               bytesEqualLower(input, at, size, 'chunked')) {
      this.#hasChunkedTransferEncoding = true;
    }
    if (this.#eager) {
      const value = input.toString('latin1', at, at + size);
      if (isHost) this.#eagerHost = value;
      ArrayPrototypePush(
        this.#eagerRawHeaders,
        input.toString('latin1', nameAt, nameAt + nameSize),
        value);
    } else {
      ArrayPrototypePush(this.#headerOffsets, nameAt, nameSize, at, size);
      if (isHost) {
        this.#hostAt = at;
        this.#hostSize = size;
      }
    }
    this.#pendingNameSize = 0;
  }

  // Decode the metadata captured so far into eager string storage, before the
  // reused parse buffer is overwritten by the next read. Called when a parse
  // ends with a request still in progress (its headers span multiple reads).
  #snapshotPartial() {
    this.#eager = true;
    const input = this.#input;
    if (this.#methodSize !== 0) {
      this.#eagerMethod = input.toString(
        'latin1', this.#methodAt, this.#methodAt + this.#methodSize);
    }
    if (this.#urlSize !== 0) {
      this.#eagerUrl = input.toString(
        'latin1', this.#urlAt, this.#urlAt + this.#urlSize);
    }
    if (this.#hostAt >= 0) {
      this.#eagerHost = input.toString(
        'latin1', this.#hostAt, this.#hostAt + this.#hostSize);
    }
    const offs = this.#headerOffsets;
    const eh = [];
    for (let i = 0; i < offs.length; i += 4) {
      ArrayPrototypePush(
        eh,
        input.toString('latin1', offs[i], offs[i] + offs[i + 1]),
        input.toString('latin1', offs[i + 2], offs[i + 2] + offs[i + 3]));
    }
    this.#eagerRawHeaders = eh;
  }

  onHeaders(at, size) {
    const m = lazyMilo();
    if (this.#sawHeaders) {
      this.#errorStatus = kStatusNotImplemented;
      m.fail(this.#parser, m.ERROR_USER, 'Trailers are not implemented');
      return;
    }
    this.#sawHeaders = true;
    this.#headersComplete = true;
    this.#waitingForHeaders = false;
    this.#headersEnd = at + size;
    this.#headersInCurrentInput = true;
    // CONNECT establishes a tunnel: milo never fires on_message_complete for it,
    // so it would otherwise hang the connection with no record and no error.
    // Reject here (headers are parsed at this point), like Upgrade.
    if (m.isConnect(this.#parser)) {
      this.#errorStatus = kStatusNotImplemented;
      m.fail(this.#parser, m.ERROR_USER, 'CONNECT is not supported');
      return;
    }
    // RFC 7231 section 5.1.1: an unsupported expectation is answered with 417.
    if (this.#expectInvalid) {
      this.#errorStatus = kStatusExpectationFailed;
      m.fail(this.#parser, m.ERROR_USER, 'Expectation failed');
      return;
    }
    if (m.hasContentLength(this.#parser) &&
        m.getContentLength(this.#parser) > this.#bodyLimitBigInt) {
      this.#errorStatus = kStatusPayloadTooLarge;
      m.fail(this.#parser, m.ERROR_USER, 'Request body is too large');
      return;
    }
    // `Expect: 100-continue`: the transport must send an interim 100 response
    // so the client proceeds to send the body. Signalled once via the result.
    if (this.#expectContinue) this.#needsContinue = true;
  }

  onData(at, size) {
    this.#ensure();
    const start = at - this.#prefixLength;
    const end = start + size;
    const chunk =
      start >= 0 && end <= this.#bodyInput.length ?
        this.#bodyInput.subarray(start, end) :
        Buffer.from(this.#input.subarray(at, at + size));
    ArrayPrototypePush(this.#body, chunk);
    this.#bodyLength += size;
    if (this.#bodyLength > this.#options.bodyLimit && this.#errorStatus === 0) {
      this.#errorStatus = kStatusPayloadTooLarge;
      const m = lazyMilo();
      m.fail(this.#parser, m.ERROR_USER, 'Request body is too large');
    }
  }

  onMessageComplete(at) {
    if (this.#headersInCurrentInput &&
        this.#hasChunkedTransferEncoding &&
        this.#hasChunkedTrailers(at)) {
      this.#errorStatus = kStatusNotImplemented;
      return;
    }
    const finished = this.#finishRecord();
    if (finished.errorStatus !== 0) {
      this.#errorStatus = finished.errorStatus;
      const m = lazyMilo();
      m.fail(this.#parser, m.ERROR_USER, 'Invalid request');
      return;
    }
    ArrayPrototypePush(this.#records, finished.record);
    this.#inMessage = false;
    this.#waitingForHeaders = true;
  }

  onError() {
    if (this.#errorStatus === 0) this.#errorStatus = kStatusBadRequest;
  }

  #ensure() {
    if (!this.#inMessage) this.onMessageStart();
  }

  #hasChunkedTrailers(completeAt) {
    let offset = this.#headersEnd;
    const input = this.#input;
    while (offset < completeAt) {
      let size = 0;
      let sawDigit = false;
      while (offset < completeAt) {
        const ch = input[offset++];
        if (ch === 0x3b) break;  // ;
        if (ch === kCR) {
          if (input[offset++] !== kLF || !sawDigit) return false;
          break;
        }
        let digit = -1;
        if (ch >= 0x30 && ch <= 0x39) digit = ch - 0x30;
        else if (ch >= 0x41 && ch <= 0x46) digit = ch - 0x41 + 10;
        else if (ch >= 0x61 && ch <= 0x66) digit = ch - 0x61 + 10;
        else return false;
        sawDigit = true;
        size = size * 16 + digit;
      }
      if (input[offset - 1] !== kLF) {
        while (offset < completeAt && input[offset] !== kCR) offset++;
        if (input[offset++] !== kCR || input[offset++] !== kLF) return false;
      }
      if (size === 0) {
        return input[offset] !== kCR || input[offset + 1] !== kLF;
      }
      offset += size;
      if (input[offset++] !== kCR || input[offset++] !== kLF) return false;
    }
    return false;
  }
}

function createRequestParser(options) {
  return new MiloRequestParser(options);
}

module.exports = ObjectFreeze({
  createRequestParser,
  kStatusBadRequest,
  kStatusRequestHeaderFieldsTooLarge,
});
