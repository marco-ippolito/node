#include "async_wrap-inl.h"
#include "env-inl.h"
#include "handle_wrap.h"
#include "node_buffer.h"
#include "node_external_reference.h"
#include "node_sockaddr-inl.h"
#include "permission/permission.h"
#include "timer_wrap-inl.h"
#include "util-inl.h"

#include <cstring>
#include <memory>
#include <utility>
#include <vector>

namespace node {
namespace web_http_server {

using v8::Array;
using v8::ArrayBuffer;
using v8::ArrayBufferView;
using v8::BackingStore;
using v8::Context;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::HandleScope;
using v8::Integer;
using v8::Isolate;
using v8::Local;
using v8::Object;
using v8::String;
using v8::Value;

namespace {

constexpr int kBacklog = 511;
constexpr size_t kReadBufferSize = 8 * 1024;

Local<String> OneByteString(Isolate* isolate, const char* value) {
  return String::NewFromOneByte(
             isolate, reinterpret_cast<const uint8_t*>(value))
      .ToLocalChecked();
}

class WebHttpConnection;

class WriteRequest final {
 public:
  explicit WriteRequest(WebHttpConnection* connection)
      : connection(connection) {
    req.data = this;
  }

  uv_write_t req;
  WebHttpConnection* connection;
  std::vector<uv_buf_t> bufs;
  std::vector<std::shared_ptr<BackingStore>> backing_stores;
  std::vector<std::unique_ptr<char[]>> copies;
};

class WebHttpConnection final : public HandleWrap {
 public:
  static void New(const FunctionCallbackInfo<Value>& args) {
    CHECK(args.IsConstructCall());
    Environment* env = Environment::GetCurrent(args);
    new WebHttpConnection(env, args.This());
  }

  static void StartRead(const FunctionCallbackInfo<Value>& args) {
    WebHttpConnection* connection;
    ASSIGN_OR_RETURN_UNWRAP(
        &connection, args.This(), args.GetReturnValue().Set(UV_EBADF));
    int err = uv_read_start(
        reinterpret_cast<uv_stream_t*>(&connection->handle_),
        AllocCallback,
        ReadCallback);
    args.GetReturnValue().Set(err);
  }

  static void StopRead(const FunctionCallbackInfo<Value>& args) {
    WebHttpConnection* connection;
    ASSIGN_OR_RETURN_UNWRAP(
        &connection, args.This(), args.GetReturnValue().Set(UV_EBADF));
    int err = uv_read_stop(
        reinterpret_cast<uv_stream_t*>(&connection->handle_));
    args.GetReturnValue().Set(err);
  }

  static void Writev(const FunctionCallbackInfo<Value>& args) {
    WebHttpConnection* connection;
    ASSIGN_OR_RETURN_UNWRAP(
        &connection, args.This(), args.GetReturnValue().Set(UV_EBADF));
    Environment* env = connection->env();
    Local<Context> context = env->context();

    CHECK(args[0]->IsArray());
    Local<Array> array = args[0].As<Array>();
    uint32_t len = array->Length();
    if (len == 0) {
      args.GetReturnValue().Set(0);
      return;
    }

    auto* write = new WriteRequest(connection);
    write->bufs.reserve(len);
    write->backing_stores.reserve(len);

    for (uint32_t i = 0; i < len; i++) {
      Local<Value> chunk;
      if (!array->Get(context, i).ToLocal(&chunk)) {
        delete write;
        return;
      }
      if (!chunk->IsArrayBufferView()) {
        delete write;
        args.GetReturnValue().Set(UV_EINVAL);
        return;
      }
      Local<ArrayBufferView> view = chunk.As<ArrayBufferView>();
      const size_t length = view->ByteLength();
      if (length == 0) continue;

      Local<ArrayBuffer> buffer = view->Buffer();
      std::shared_ptr<BackingStore> store = buffer->GetBackingStore();
      char* data = static_cast<char*>(store->Data());
      if (data == nullptr) {
        delete write;
        args.GetReturnValue().Set(UV_EINVAL);
        return;
      }
      data += view->ByteOffset();

      // Normal ArrayBuffer backing stores keep their bytes alive across
      // detach as long as the shared_ptr is retained. User-resizable backing
      // stores can move, so snapshot those rare chunks before uv_write().
      if (buffer->IsResizableByUserJavaScript()) {
        auto copy = std::make_unique<char[]>(length);
        memcpy(copy.get(), data, length);
        write->bufs.push_back(uv_buf_init(
            copy.get(), static_cast<unsigned int>(length)));
        write->copies.push_back(std::move(copy));
      } else {
        write->bufs.push_back(uv_buf_init(
            data, static_cast<unsigned int>(length)));
        write->backing_stores.push_back(std::move(store));
      }
    }

    if (write->bufs.empty()) {
      // Nothing to write (all chunks were zero-length). Return 0 like a queued
      // write, but note no uv_write() is issued so AfterWrite/onwrite will NOT
      // fire. Callers must not assume a 0 return always schedules a write
      // completion. Safe today because every flushed slot carries a non-empty
      // serialized response head.
      delete write;
      args.GetReturnValue().Set(0);
      return;
    }

    int err = uv_write(&write->req,
                       reinterpret_cast<uv_stream_t*>(&connection->handle_),
                       write->bufs.data(),
                       static_cast<unsigned int>(write->bufs.size()),
                       AfterWrite);
    if (err != 0) delete write;
    args.GetReturnValue().Set(err);
  }

  static void SetTimeout(const FunctionCallbackInfo<Value>& args) {
    WebHttpConnection* connection;
    ASSIGN_OR_RETURN_UNWRAP(
        &connection, args.This(), args.GetReturnValue().Set(UV_EBADF));
    CHECK(args[0]->IsUint32());
    uint32_t timeout;
    if (!args[0]->Uint32Value(connection->env()->context()).To(&timeout)) {
      return;
    }
    if (timeout == 0) {
      connection->timer_.Stop();
    } else {
      connection->timer_.Update(timeout);
      connection->timer_.Unref();
    }
  }

  static void StopTimeout(const FunctionCallbackInfo<Value>& args) {
    WebHttpConnection* connection;
    ASSIGN_OR_RETURN_UNWRAP(
        &connection, args.This(), args.GetReturnValue().Set(UV_EBADF));
    connection->timer_.Stop();
  }

  SET_NO_MEMORY_INFO()
  SET_MEMORY_INFO_NAME(WebHttpConnection)
  SET_SELF_SIZE(WebHttpConnection)

 private:
  friend class WebHttpServer;

  WebHttpConnection(Environment* env, Local<Object> object)
      : HandleWrap(env,
                   object,
                   reinterpret_cast<uv_handle_t*>(&handle_),
                   AsyncWrap::PROVIDER_TCPWRAP),
        timer_(env, [this] { OnTimeout(); }) {
    int err = uv_tcp_init(env->event_loop(), &handle_);
    CHECK_EQ(err, 0);
  }

  void OnClose() override {
    timer_.Close();
  }

  void OnTimeout() {
    if (IsHandleClosing()) return;
    Environment* env = this->env();
    Isolate* isolate = env->isolate();
    HandleScope handle_scope(isolate);
    Context::Scope context_scope(env->context());
    MakeCallback(OneByteString(isolate, "ontimeout"), 0, nullptr);
  }

  static void AllocCallback(uv_handle_t* handle,
                            size_t suggested_size,
                            uv_buf_t* buf) {
    size_t size = suggested_size == 0 || suggested_size > kReadBufferSize ?
        kReadBufferSize : suggested_size;
    buf->base = new char[size];
    buf->len = size;
  }

  static void FreeReadBuffer(char* data, void* hint) {
    delete[] data;
  }

  static void ReadCallback(uv_stream_t* stream,
                           ssize_t nread,
                           const uv_buf_t* buf) {
    WebHttpConnection* connection =
        static_cast<WebHttpConnection*>(stream->data);
    CHECK_NOT_NULL(connection);
    Environment* env = connection->env();
    Isolate* isolate = env->isolate();
    HandleScope handle_scope(isolate);
    Context::Scope context_scope(env->context());

    Local<Value> argv[2];
    argv[0] = Integer::New(isolate, static_cast<int32_t>(nread));
    if (nread > 0) {
      Local<Object> buffer;
      if (!Buffer::New(env,
                       buf->base,
                       static_cast<size_t>(nread),
                       FreeReadBuffer,
                       nullptr)
               .ToLocal(&buffer)) {
        delete[] buf->base;
        return;
      }
      argv[1] = buffer;
    } else {
      delete[] buf->base;
      argv[1] = Undefined(isolate);
    }

    connection->MakeCallback(
        OneByteString(isolate, "onread"), arraysize(argv), argv);
  }

  static void AfterWrite(uv_write_t* req, int status) {
    WriteRequest* write = static_cast<WriteRequest*>(req->data);
    WebHttpConnection* connection = write->connection;
    Environment* env = connection->env();
    Isolate* isolate = env->isolate();
    HandleScope handle_scope(isolate);
    Context::Scope context_scope(env->context());

    Local<Value> argv[] = {Integer::New(isolate, status)};
    connection->MakeCallback(
        OneByteString(isolate, "onwrite"), arraysize(argv), argv);
    delete write;
  }

  uv_tcp_t handle_;
  TimerWrapHandle timer_;
};

class WebHttpServer final : public HandleWrap {
 public:
  static void Initialize(Local<Object> target,
                         Local<Value> unused,
                         Local<Context> context,
                         void* priv) {
    Environment* env = Environment::GetCurrent(context);
    Isolate* isolate = env->isolate();

    Local<FunctionTemplate> server_t = NewFunctionTemplate(isolate, New);
    server_t->InstanceTemplate()->SetInternalFieldCount(
        WebHttpServer::kInternalFieldCount);
    server_t->Inherit(HandleWrap::GetConstructorTemplate(env));
    SetProtoMethod(isolate, server_t, "bind", Bind);
    SetProtoMethod(isolate, server_t, "listen", Listen);
    SetProtoMethod(isolate, server_t, "address", Address);
    SetConstructorFunction(context, target, "WebHttpServer", server_t);

    Local<FunctionTemplate> connection_t =
        NewFunctionTemplate(isolate, WebHttpConnection::New);
    connection_t->InstanceTemplate()->SetInternalFieldCount(
        WebHttpConnection::kInternalFieldCount);
    connection_t->Inherit(HandleWrap::GetConstructorTemplate(env));
    SetProtoMethod(isolate, connection_t, "startRead",
                   WebHttpConnection::StartRead);
    SetProtoMethod(isolate, connection_t, "stopRead",
                   WebHttpConnection::StopRead);
    SetProtoMethod(isolate, connection_t, "setTimeout",
                   WebHttpConnection::SetTimeout);
    SetProtoMethod(isolate, connection_t, "stopTimeout",
                   WebHttpConnection::StopTimeout);
    SetProtoMethod(isolate, connection_t, "writev",
                   WebHttpConnection::Writev);
    SetConstructorFunction(context, target, "WebHttpConnection", connection_t);
  }

  static void RegisterExternalReferences(ExternalReferenceRegistry* registry) {
    registry->Register(New);
    registry->Register(Bind);
    registry->Register(Listen);
    registry->Register(Address);
    registry->Register(WebHttpConnection::New);
    registry->Register(WebHttpConnection::StartRead);
    registry->Register(WebHttpConnection::StopRead);
    registry->Register(WebHttpConnection::SetTimeout);
    registry->Register(WebHttpConnection::StopTimeout);
    registry->Register(WebHttpConnection::Writev);
  }

  SET_NO_MEMORY_INFO()
  SET_MEMORY_INFO_NAME(WebHttpServer)
  SET_SELF_SIZE(WebHttpServer)

 private:
  static void New(const FunctionCallbackInfo<Value>& args) {
    CHECK(args.IsConstructCall());
    Environment* env = Environment::GetCurrent(args);
    new WebHttpServer(env, args.This());
  }

  WebHttpServer(Environment* env, Local<Object> object)
      : HandleWrap(env,
                   object,
                   reinterpret_cast<uv_handle_t*>(&handle_),
                   AsyncWrap::PROVIDER_TCPSERVERWRAP) {
    int err = uv_tcp_init(env->event_loop(), &handle_);
    CHECK_EQ(err, 0);
  }

  static void Bind(const FunctionCallbackInfo<Value>& args) {
    WebHttpServer* server;
    ASSIGN_OR_RETURN_UNWRAP(
        &server, args.This(), args.GetReturnValue().Set(UV_EBADF));
    Environment* env = server->env();

    CHECK(args[0]->IsString());
    Utf8Value host(env->isolate(), args[0]);
    int port;
    if (!args[1]->Int32Value(env->context()).To(&port)) return;

    sockaddr_storage addr;
    int err = uv_ip4_addr(
        *host, port, reinterpret_cast<sockaddr_in*>(&addr));
    if (err != 0) {
      err = uv_ip6_addr(
          *host, port, reinterpret_cast<sockaddr_in6*>(&addr));
    }
    if (err != 0) {
      return env->ThrowUVException(err, "bind", nullptr, *host);
    }

    err = uv_tcp_bind(&server->handle_,
                      reinterpret_cast<const sockaddr*>(&addr),
                      0);
    if (err != 0) {
      return env->ThrowUVException(err, "bind", nullptr, *host);
    }
  }

  static void Listen(const FunctionCallbackInfo<Value>& args) {
    WebHttpServer* server;
    ASSIGN_OR_RETURN_UNWRAP(
        &server, args.This(), args.GetReturnValue().Set(UV_EBADF));
    Environment* env = server->env();
    THROW_IF_INSUFFICIENT_PERMISSIONS(
        env, permission::PermissionScope::kNet, "");
    int err = uv_listen(reinterpret_cast<uv_stream_t*>(&server->handle_),
                        kBacklog,
                        OnConnection);
    if (err != 0) {
      return env->ThrowUVException(err, "listen");
    }
  }

  static void Address(const FunctionCallbackInfo<Value>& args) {
    WebHttpServer* server;
    ASSIGN_OR_RETURN_UNWRAP(&server, args.This());
    Environment* env = server->env();
    Isolate* isolate = env->isolate();

    sockaddr_storage addr;
    int len = sizeof(addr);
    int err = uv_tcp_getsockname(
        &server->handle_, reinterpret_cast<sockaddr*>(&addr), &len);
    if (err != 0) {
      args.GetReturnValue().Set(err);
      return;
    }

    const sockaddr* sock_addr = reinterpret_cast<const sockaddr*>(&addr);
    const char* family;
    int port;
    char ip[64];
    if (sock_addr->sa_family == AF_INET) {
      const sockaddr_in* addr4 = reinterpret_cast<const sockaddr_in*>(&addr);
      err = uv_ip4_name(addr4, ip, sizeof(ip));
      family = "IPv4";
    } else if (sock_addr->sa_family == AF_INET6) {
      const sockaddr_in6* addr6 = reinterpret_cast<const sockaddr_in6*>(&addr);
      err = uv_ip6_name(addr6, ip, sizeof(ip));
      family = "IPv6";
    } else {
      args.GetReturnValue().Set(UV_EINVAL);
      return;
    }
    if (err != 0) {
      args.GetReturnValue().Set(err);
      return;
    }
    port = SocketAddress::GetPort(sock_addr);

    Local<Object> out = Object::New(isolate);
    Local<Context> context = env->context();
    out->Set(context, OneByteString(isolate, "address"),
             OneByteString(isolate, ip)).Check();
    out->Set(context, OneByteString(isolate, "family"),
             OneByteString(isolate, family)).Check();
    out->Set(context, OneByteString(isolate, "port"),
             Integer::New(isolate, port)).Check();
    args.GetReturnValue().Set(out);
  }

  static void OnConnection(uv_stream_t* handle, int status) {
    WebHttpServer* server = static_cast<WebHttpServer*>(handle->data);
    CHECK_NOT_NULL(server);
    Environment* env = server->env();
    Isolate* isolate = env->isolate();
    HandleScope handle_scope(isolate);
    Context::Scope context_scope(env->context());
    Local<Context> context = env->context();

    Local<Value> client = Undefined(isolate);
    if (status == 0) {
      Local<Value> constructor_value;
      if (!server->object()
               ->Get(context, OneByteString(isolate, "connectionConstructor"))
               .ToLocal(&constructor_value) ||
          !constructor_value->IsFunction()) {
        RejectPendingConnection(env, handle);
        status = UV_EINVAL;
      } else {
        Local<Object> client_object;
        if (!constructor_value.As<Function>()
                 ->NewInstance(context, 0, nullptr)
                 .ToLocal(&client_object)) {
          RejectPendingConnection(env, handle);
          return;
        }

        WebHttpConnection* connection =
            static_cast<WebHttpConnection*>(BaseObject::FromJSObject(
                client_object));
        if (connection == nullptr) {
          RejectPendingConnection(env, handle);
          status = UV_EINVAL;
        } else {
          int err = uv_accept(
              handle, reinterpret_cast<uv_stream_t*>(&connection->handle_));
          if (err != 0) {
            connection->Close();
            status = err;
          } else {
            uv_tcp_nodelay(&connection->handle_, 1);
            client = client_object;
          }
        }
      }
    }

    Local<Value> argv[] = {Integer::New(isolate, status), client};
    server->MakeCallback(env->onconnection_string(), arraysize(argv), argv);
  }

  static void CloseRejectedConnection(uv_handle_t* handle) {
    delete reinterpret_cast<uv_tcp_t*>(handle);
  }

  static void RejectPendingConnection(Environment* env, uv_stream_t* handle) {
    auto* client = new uv_tcp_t();
    int err = uv_tcp_init(env->event_loop(), client);
    if (err != 0) {
      delete client;
      return;
    }
    uv_accept(handle, reinterpret_cast<uv_stream_t*>(client));
    uv_close(reinterpret_cast<uv_handle_t*>(client), CloseRejectedConnection);
  }

  uv_tcp_t handle_;
};

}  // namespace

void Initialize(Local<Object> target,
                Local<Value> unused,
                Local<Context> context,
                void* priv) {
  WebHttpServer::Initialize(target, unused, context, priv);
}

void RegisterExternalReferences(ExternalReferenceRegistry* registry) {
  WebHttpServer::RegisterExternalReferences(registry);
}

}  // namespace web_http_server
}  // namespace node

NODE_BINDING_CONTEXT_AWARE_INTERNAL(web_http_server,
                                    node::web_http_server::Initialize)
NODE_BINDING_EXTERNAL_REFERENCE(
    web_http_server, node::web_http_server::RegisterExternalReferences)
