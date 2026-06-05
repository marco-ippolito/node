'use strict';

const {
  ArrayPrototypePush,
  MathCeil,
  MapPrototypeSet,
  SafeMap,
  StringPrototypeCharCodeAt,
  StringPrototypeToLowerCase,
  SymbolSpecies,
  TypedArrayPrototypeSet,
  TypedArrayPrototypeSubarray,
  Uint8Array,
  globalThis,
} = primordials;

const { Buffer } = require('buffer');
const { WebAssembly, ReadableStream } = globalThis;
const {
  ERR_WEB_HTTP_BODY_LIMIT,
  ERR_INVALID_STATE,
} = require('internal/errors').codes;

const FastBuffer = Buffer[SymbolSpecies];
const EMPTY_BUFFER = Buffer.alloc(0);

const HPE_OK = 0;
const HPE_PAUSED = 21;
const HPE_PAUSED_UPGRADE = 22;
// Keep this in sync with top-level deps/llhttp/include/llhttp.h. The wasm
// artifact exposes method-name lookup but not enum constants.
const HTTP_CONNECT = 5;
const HTTP_REQUEST = 1;

let llhttpInstance;
let currentParser = null;
let currentBufferRef = null;
let currentBufferSize = 0;
let currentBufferPtr = null;
let currentBuffer = null;
const methodNames = [];

function makeBuffer(at, len) {
  const start = at - currentBufferPtr + currentBufferRef.byteOffset;
  return new FastBuffer(currentBufferRef.buffer, start, len);
}

function readCString(llhttp, ptr) {
  if (!ptr) return '';
  const memory = new Uint8Array(llhttp.memory.buffer);
  let end = ptr;
  while (memory[end] !== 0) end++;
  return Buffer.from(llhttp.memory.buffer, ptr, end - ptr).toString();
}

function getMethodName(llhttp, method) {
  let name = methodNames[method];
  if (name !== undefined) {
    return name;
  }
  name = readCString(llhttp, llhttp.llhttp_method_name(method));
  methodNames[method] = name;
  return name;
}

function lazyllhttp() {
  if (llhttpInstance !== undefined) {
    return llhttpInstance;
  }

  const mod = new WebAssembly.Module(require('internal/http/llhttp-wasm')());
  llhttpInstance = new WebAssembly.Instance(mod, {
    __proto__: null,
    env: {
      __proto__: null,
      wasm_on_message_begin(p) {
        return currentParser.onMessageBegin(p);
      },
      wasm_on_url(p, at, len) {
        return currentParser.onUrl(p, makeBuffer(at, len));
      },
      wasm_on_status() {
        return 0;
      },
      wasm_on_header_field(p, at, len) {
        return currentParser.onHeaderField(p, makeBuffer(at, len));
      },
      wasm_on_header_value(p, at, len) {
        return currentParser.onHeaderValue(p, makeBuffer(at, len));
      },
      wasm_on_headers_complete(p, statusCode, upgrade, shouldKeepAlive) {
        return currentParser.onHeadersComplete(
          p,
          statusCode,
          upgrade === 1,
          shouldKeepAlive === 1,
        );
      },
      wasm_on_body(p, at, len) {
        return currentParser.onBody(p, makeBuffer(at, len));
      },
      wasm_on_message_complete(p) {
        return currentParser.onMessageComplete(p);
      },
    },
  });

  return llhttpInstance;
}

function withHTTPStatus(error, statusCode) {
  error.statusCode = statusCode;
  return error;
}

function bufferPartsToString(first, list) {
  if (first === null) {
    return '';
  }
  if (list === null) {
    return first.toString();
  }
  return Buffer.concat(list).toString();
}

function bufferPartsToOwnedBuffer(first, list) {
  if (first === null) {
    return EMPTY_BUFFER;
  }
  if (list === null) {
    return Buffer.from(first);
  }
  return Buffer.concat(list);
}

function makeHeaderMap(headerList) {
  const headers = new SafeMap();
  for (let i = 0; i < headerList.length; i += 2) {
    MapPrototypeSet(
      headers,
      StringPrototypeToLowerCase(headerList[i]),
      headerList[i + 1],
    );
  }
  return headers;
}

function isHostHeader(field) {
  return field.length === 4 &&
    (StringPrototypeCharCodeAt(field, 0) | 0x20) === 0x68 &&
    (StringPrototypeCharCodeAt(field, 1) | 0x20) === 0x6f &&
    (StringPrototypeCharCodeAt(field, 2) | 0x20) === 0x73 &&
    (StringPrototypeCharCodeAt(field, 3) | 0x20) === 0x74;
}

function createHTTPParserError(reason, code, data) {
  const message = reason ? `Parse Error: ${reason}` : 'Parse Error';
  const error = new Error(message);
  error.code = code;
  error.parserCode = code;
  error.data = data;
  error.statusCode = 400;
  return error;
}

function createBodyState() {
  return {
    __proto__: null,
    cancelled: false,
    chunks: [],
    closed: false,
    controller: null,
    error: null,
    stream: null,
  };
}

function createBodySlot(closed = false, error = null) {
  return {
    __proto__: null,
    closed,
    error,
    state: null,
  };
}

function getBodySlotState(slot) {
  if (slot.state !== null) {
    return slot.state;
  }

  const state = createBodyState();
  slot.state = state;
  if (slot.error !== null) {
    errorBody(state, slot.error);
  } else if (slot.closed) {
    closeBody(state);
  }
  return state;
}

function getBodyStream(slot) {
  const state = getBodySlotState(slot);
  if (state.stream !== null) {
    return state.stream;
  }

  // Request bodies stay as typed-array chunks until user code asks for a
  // Web stream. This keeps the parser hot path in JS/wasm without eagerly
  // constructing Web stream machinery for handlers that only inspect metadata.
  state.stream = new ReadableStream({
    __proto__: null,
    start: (controller) => {
      state.controller = controller;
      const { chunks } = state;
      if (chunks !== null) {
        for (let i = 0; i < chunks.length; i++) {
          controller.enqueue(chunks[i]);
        }
        state.chunks = null;
      }
      if (state.closed && !state.cancelled) {
        if (state.error !== null) {
          controller.error(state.error);
        } else {
          controller.close();
        }
      }
    },
    cancel: () => {
      state.cancelled = true;
      state.chunks = null;
    },
  });
  return state.stream;
}

function enqueueBody(state, buf) {
  if (state.cancelled) {
    return;
  }
  // `buf` is already a typed-array view over the externally backed read
  // buffer. Keep that view instead of copying body bytes into a new
  // Uint8Array; the underlying ArrayBuffer remains alive while the chunk is
  // queued in JS or in the Web stream.
  const chunk = buf;
  if (state.controller !== null) {
    state.controller.enqueue(chunk);
  } else {
    ArrayPrototypePush(state.chunks, chunk);
  }
}

function closeBody(state) {
  if (state.closed) {
    return;
  }
  state.closed = true;
  if (state.controller !== null && !state.cancelled) {
    state.controller.close();
  }
}

function errorBody(state, error) {
  if (state.closed) {
    return;
  }
  state.closed = true;
  state.error = error;
  state.chunks = null;
  if (state.controller !== null && !state.cancelled) {
    state.controller.error(error);
  }
}

function enqueueBodySlot(slot, buf) {
  enqueueBody(getBodySlotState(slot), buf);
}

function closeBodySlot(slot) {
  slot.closed = true;
  if (slot.state !== null) {
    closeBody(slot.state);
  }
}

function errorBodySlot(slot, error) {
  slot.closed = true;
  slot.error = error;
  if (slot.state !== null) {
    errorBody(slot.state, error);
  }
}

function getRecordBodySlot(record) {
  let slot = record.bodySlot;
  if (slot === null) {
    slot = createBodySlot(record.bodyClosed, record.bodyError);
    record.bodySlot = slot;
  }
  return slot;
}

function enqueueRecordBody(record, buf) {
  enqueueBodySlot(getRecordBodySlot(record), buf);
}

function closeRecordBody(record) {
  const slot = record.bodySlot;
  record.bodyClosed = true;
  if (slot !== null) {
    closeBodySlot(slot);
  }
}

function errorRecordBody(record, error) {
  const slot = record.bodySlot;
  record.bodyClosed = true;
  record.bodyError = error;
  if (slot !== null) {
    errorBodySlot(slot, error);
  }
}

class HTTP1RequestRecord {
  #headers;
  #llhttp;
  #method;
  #methodName;
  #url;
  #urlBuffer;

  constructor(parser, method, shouldKeepAlive, upgrade) {
    const { llhttp } = parser;
    this.#llhttp = llhttp;
    this.#method = method;
    this.#methodName = undefined;
    this.#url = undefined;
    // URL tokens point into the reusable native read slab while parsing. Copy
    // just the URL bytes into request-owned storage so string materialization
    // can stay lazy without pinning or observing later slab reuse.
    this.#urlBuffer = bufferPartsToOwnedBuffer(parser.url, parser.urlList);
    this.host = parser.host;
    this.headerList = parser.headerList;
    this.bodySlot = null;
    this.bodyClosed = false;
    this.bodyError = null;
    this.httpVersionMajor = llhttp.llhttp_get_http_major(parser.ptr);
    this.httpVersionMinor = llhttp.llhttp_get_http_minor(parser.ptr);
    this.shouldKeepAlive = shouldKeepAlive;
    this.upgrade = upgrade;
    this.#headers = undefined;
  }

  get method() {
    return this.#methodName ??= getMethodName(this.#llhttp, this.#method);
  }

  get methodCode() {
    return this.#method;
  }

  get url() {
    return this.#url ??= this.#urlBuffer.toString();
  }

  get headers() {
    return this.#headers ??= makeHeaderMap(this.headerList);
  }

  get body() {
    return getBodyStream(getRecordBodySlot(this));
  }
}

class HTTP1RequestParser {
  constructor(options) {
    const { exports } = lazyllhttp();
    this.llhttp = exports;
    this.ptr = this.llhttp.llhttp_alloc(HTTP_REQUEST);
    this.maxHeaderSize = options.maxHeaderSize;
    this.bodyLimit = options.bodyLimit;
    this.onRequest = options.onRequest;
    this.onRequestComplete = options.onRequestComplete;
    this.closed = false;
    this.resetMessage();
  }

  execute(chunk) {
    if (this.closed) {
      throw new ERR_INVALID_STATE('HTTP parser is closed');
    }
    if (chunk.length === 0) {
      return false;
    }

    const { llhttp } = this;
    this.retainedBuffer = false;

    if (chunk.length > currentBufferSize) {
      if (currentBufferPtr !== null) {
        llhttp.free(currentBufferPtr);
      }
      currentBufferSize = MathCeil(chunk.length / 4096) * 4096;
      currentBufferPtr = llhttp.malloc(currentBufferSize);
    }

    if (
      currentBuffer === null ||
      currentBuffer.buffer !== llhttp.memory.buffer ||
      currentBuffer.byteOffset !== currentBufferPtr ||
      currentBuffer.byteLength !== currentBufferSize
    ) {
      currentBuffer = new Uint8Array(
        llhttp.memory.buffer,
        currentBufferPtr,
        currentBufferSize,
      );
    }

    TypedArrayPrototypeSet(currentBuffer, chunk);

    let ret;
    try {
      currentParser = this;
      currentBufferRef = chunk;
      ret = llhttp.llhttp_execute(this.ptr, currentBufferPtr, chunk.length);
    } finally {
      currentParser = null;
      currentBufferRef = null;
    }

    if (ret === HPE_OK) {
      return this.retainedBuffer;
    }

    const errorPos = llhttp.llhttp_get_error_pos(this.ptr);
    const offset = errorPos - currentBufferPtr;
    const data = offset >= 0 ? TypedArrayPrototypeSubarray(chunk, offset) : Buffer.alloc(0);

    const error = this.error ?? this.createError(ret, data);
    if (this.current !== null) {
      errorRecordBody(this.current, error);
    }
    throw error;
  }

  finish() {
    if (this.closed) {
      return;
    }

    let ret;
    try {
      currentParser = this;
      ret = this.llhttp.llhttp_finish(this.ptr);
    } finally {
      currentParser = null;
    }

    if (ret !== HPE_OK && ret !== HPE_PAUSED && ret !== HPE_PAUSED_UPGRADE) {
      throw this.error ?? this.createError(ret, Buffer.alloc(0));
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.llhttp.llhttp_free(this.ptr);
    this.closed = true;
  }

  reset() {
    if (this.closed) {
      throw new ERR_INVALID_STATE('HTTP parser is closed');
    }
    this.llhttp.llhttp_reset(this.ptr);
    this.resetMessage();
  }

  createError(ret, data) {
    const reason = readCString(this.llhttp, this.llhttp.llhttp_get_error_reason(this.ptr));
    const code = readCString(this.llhttp, this.llhttp.llhttp_errno_name(ret));
    return createHTTPParserError(reason, code, data);
  }

  resetMessage() {
    this.url = null;
    this.urlList = null;
    this.headerField = null;
    this.headerFieldList = null;
    this.headerValue = null;
    this.headerValueList = null;
    this.headerList = [];
    this.headerSize = 0;
    this.host = undefined;
    this.hostSeen = false;
    this.bodySize = 0;
    this.current = null;
    this.error = null;
  }

  trackHeader(bytes) {
    this.headerSize += bytes;
    if (this.headerSize > this.maxHeaderSize) {
      this.error = withHTTPStatus(
        createHTTPParserError(
          'Header overflow',
          'HPE_HEADER_OVERFLOW',
          Buffer.alloc(0),
        ),
        431,
      );
      return -1;
    }
    return 0;
  }

  onMessageBegin() {
    this.resetMessage();
    return 0;
  }

  onUrl(_p, buf) {
    if (this.url === null) {
      this.url = buf;
    } else if (this.urlList === null) {
      this.urlList = [this.url, buf];
    } else {
      ArrayPrototypePush(this.urlList, buf);
    }
    return this.trackHeader(buf.length);
  }

  onHeaderField(_p, buf) {
    if (this.headerValue !== null) {
      const ret = this.commitHeader();
      if (ret !== 0) {
        return ret;
      }
    }
    if (this.headerField === null) {
      this.headerField = buf;
    } else if (this.headerFieldList === null) {
      this.headerFieldList = [this.headerField, buf];
    } else {
      ArrayPrototypePush(this.headerFieldList, buf);
    }
    return this.trackHeader(buf.length);
  }

  onHeaderValue(_p, buf) {
    if (this.headerValue === null) {
      this.headerValue = buf;
    } else if (this.headerValueList === null) {
      this.headerValueList = [this.headerValue, buf];
    } else {
      ArrayPrototypePush(this.headerValueList, buf);
    }
    return this.trackHeader(buf.length);
  }

  onHeadersComplete(_p, _statusCode, upgrade, shouldKeepAlive) {
    if (this.headerField !== null || this.headerValue !== null) {
      const ret = this.commitHeader();
      if (ret !== 0) {
        return ret;
      }
    }

    // Keep the per-request map lazy. The transport fast path only needs Host,
    // while tests and user-facing protocol objects can still access
    // record.headers with the previous Map-like behavior.
    const method = this.llhttp.llhttp_get_method(this.ptr);
    this.current = new HTTP1RequestRecord(
      this,
      method,
      shouldKeepAlive,
      upgrade,
    );

    return this.onRequest(this.current) || 0;
  }

  onBody(_p, buf) {
    this.bodySize += buf.length;
    if (this.bodyLimit !== 0 && this.bodySize > this.bodyLimit) {
      this.error = withHTTPStatus(
        new ERR_WEB_HTTP_BODY_LIMIT(this.bodyLimit),
        413,
      );
      if (this.current !== null) {
        errorRecordBody(this.current, this.error);
      }
      return -1;
    }
    if (this.current !== null) {
      enqueueRecordBody(this.current, buf);
      this.retainedBuffer = true;
    }
    return 0;
  }

  onMessageComplete() {
    if (this.current !== null) {
      closeRecordBody(this.current);
    }
    this.onRequestComplete(this.current);
    return 0;
  }

  commitHeader() {
    const field = bufferPartsToString(this.headerField, this.headerFieldList);
    const value = bufferPartsToString(this.headerValue, this.headerValueList);
    if (isHostHeader(field)) {
      if (this.hostSeen) {
        this.error = createHTTPParserError(
          'Duplicate Host header',
          'HPE_INVALID_HEADER_TOKEN',
          Buffer.alloc(0),
        );
        return -1;
      }
      this.hostSeen = true;
      this.host = value;
    }
    ArrayPrototypePush(this.headerList, field, value);
    this.headerField = null;
    this.headerFieldList = null;
    this.headerValue = null;
    this.headerValueList = null;
    return 0;
  }
}

module.exports = {
  HTTP_CONNECT,
  HTTP1RequestParser,
};
