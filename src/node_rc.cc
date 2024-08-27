#include "node_rc.h"
#include "debug_utils-inl.h"
#include "env-inl.h"
#include "json_parser.h"
#include "node_errors.h"
#include "node_file.h"
#include "node_internals.h"

#include <functional>
#include <map>
#include <string>

namespace node {

ConfigRC::ConfigV0 ConfigRC::ParseConfigV0(const std::string& data) {
  return {"v0"};
}

ConfigRC::ConfigRC() {
  parsers_["v0"] = [](const std::string& data) -> ConfigRC::Config {
    return ConfigRC::ParseConfigV0(data);
  };
}

std::optional<ConfigRC::Config> ConfigRC::ParseConfig(
    const std::string& config_path) {


  std::string file_content;
  // Read the configuration file
  int r = ReadFileSync(&file_content, config_path.c_str());
  if (r != 0) {
    const char* err = uv_strerror(r);
    FPrintF(
        stderr, "Cannot read configuration from %s: %s\n", config_path, err);
    return std::nullopt;
  }

  // Parse the configuration file
  JSONParser parser;
  if (!parser.Parse(file_content)) {
    FPrintF(stderr, "Cannot parse JSON from %s\n", config_path);
    return std::nullopt;
  }

  // Get the version field from the configuration file
  auto version =
      parser.GetTopLevelStringField("version").value_or(std::string());


  // Check if the version field is a non-empty string
  if (version.empty()) {
    FPrintF(stderr,
            "\"version\" field of %s is not a non-empty string\n",
            config_path);
    return std::nullopt;
  }

  // Check if there is a parser for the version
  auto it = parsers_.find(version);
  if (it == parsers_.end()) {
    FPrintF(stderr, "Version %s does not exist\n", version);
    return std::nullopt;
  }

  auto config_parser = it->second;
  return config_parser(file_content);
}

}  // namespace node
