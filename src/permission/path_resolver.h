#ifndef SRC_PERMISSION_PATH_RESOLVER_H_
#define SRC_PERMISSION_PATH_RESOLVER_H_

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#include <string_view>

namespace node {

namespace permission {

class Path {
 public:
  Path();
  static bool IsAbsolutePath(const std::string_view& path);

  static std::string Resolve(const std::string_view& path);
};

}  // namespace permission

}  // namespace node

#endif  // defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS
#endif  // SRC_PERMISSION_PATH_RESOLVER_H_
