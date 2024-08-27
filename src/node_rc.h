#ifndef SRC_NODE_RC_H_
#define SRC_NODE_RC_H_

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#include <map>
#include <string>
#include <variant>

#include "util-inl.h"

namespace node {

class ConfigRC {
 public:
  struct ConfigV0 {
    std::string version;
  };
  using Config = std::variant<ConfigV0>;
  ConfigRC();
  std::optional<ConfigRC::Config> ParseConfig(
      const std::string& config_path);

 private:
  static ConfigRC::ConfigV0 ParseConfigV0(const std::string& data);
  std::unordered_map<std::string,
                     std::function<ConfigRC::Config(const std::string&)>>
      parsers_;
};

}  // namespace node

#endif  // defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#endif  // SRC_NODE_RC_H_
