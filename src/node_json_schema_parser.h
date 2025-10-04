#ifndef SRC_NODE_JSON_SCHEMA_PARSER_H_
#define SRC_NODE_JSON_SCHEMA_PARSER_H_

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <vector>
#include "base_object.h"
#include "node_internals.h"
#include "simdjson.h"

namespace node {
namespace json_schema_parser {

using v8::FunctionCallbackInfo;
using v8::Value;

// JSON Schema type enumeration
enum class JSONSchemaType {
  STRING,
  NUMBER,
  INTEGER,
  BOOLEAN,
  OBJECT,
  ARRAY,
  NULL_TYPE
};

// Forward declaration
struct JSONSchemaStruct;

// Type alias for schema properties (object schemas)
using SchemaProperties =
    std::unordered_map<std::string, std::unique_ptr<JSONSchemaStruct>>;

// Type alias for schema array items
using SchemaItems = std::variant<
    std::unique_ptr<JSONSchemaStruct>,  // Single schema for all items
    std::vector<std::unique_ptr<JSONSchemaStruct>>  // Tuple validation
    >;

// JSON Schema representation based on JSON Schema 2020-12
struct JSONSchemaStruct {
  // Core vocabulary
  std::string schema_version;  // $schema
  std::string id;              // $id
  std::string ref;             // $ref
  std::string anchor;          // $anchor
  std::string dynamic_ref;     // $dynamicRef
  std::string dynamic_anchor;  // $dynamicAnchor
  std::string vocabulary;      // $vocabulary
  std::string comment;         // $comment

  // Type and basic validation
  std::unordered_set<JSONSchemaType> types;  // type (can be array)

  // String validation
  size_t min_length = 0;         // minLength
  size_t max_length = SIZE_MAX;  // maxLength
  std::string pattern;           // pattern
  std::string format;            // format

  // Numeric validation
  double minimum = -INFINITY;            // minimum
  double maximum = INFINITY;             // maximum
  double exclusive_minimum = -INFINITY;  // exclusiveMinimum
  double exclusive_maximum = INFINITY;   // exclusiveMaximum
  double multiple_of = 0;                // multipleOf

  // Object validation
  SchemaProperties properties;               // properties
  std::unordered_set<std::string> required;  // required
  std::unique_ptr<JSONSchemaStruct>
      additional_properties;         // additionalProperties
  size_t min_properties = 0;         // minProperties
  size_t max_properties = SIZE_MAX;  // maxProperties

  // Array validation
  SchemaItems items;  // items
  std::unique_ptr<JSONSchemaStruct>
      additional_items;         // additionalItems (deprecated in 2020-12)
  size_t min_items = 0;         // minItems
  size_t max_items = SIZE_MAX;  // maxItems
  bool unique_items = false;    // uniqueItems

  // Conditional schemas
  std::unique_ptr<JSONSchemaStruct> if_schema;    // if
  std::unique_ptr<JSONSchemaStruct> then_schema;  // then
  std::unique_ptr<JSONSchemaStruct> else_schema;  // else

  // Logical schemas
  std::vector<std::unique_ptr<JSONSchemaStruct>> all_of;  // allOf
  std::vector<std::unique_ptr<JSONSchemaStruct>> any_of;  // anyOf
  std::vector<std::unique_ptr<JSONSchemaStruct>> one_of;  // oneOf
  std::unique_ptr<JSONSchemaStruct> not_schema;           // not

  // Metadata
  std::string title;                  // title
  std::string description;            // description
  std::string default_value;          // default (stored as JSON string)
  std::vector<std::string> examples;  // examples

  // Constructor
  JSONSchemaStruct() = default;

  // Move constructor and assignment
  JSONSchemaStruct(JSONSchemaStruct&&) = default;
  JSONSchemaStruct& operator=(JSONSchemaStruct&&) = default;

  // Delete copy constructor and assignment (due to unique_ptr members)
  JSONSchemaStruct(const JSONSchemaStruct&) = delete;
  JSONSchemaStruct& operator=(const JSONSchemaStruct&) = delete;
};

// JSON Schema Parser class
class JSONSchemaParser : public BaseObject {
 public:
  SET_NO_MEMORY_INFO()
  SET_MEMORY_INFO_NAME(JSONSchemaParser)
  SET_SELF_SIZE(JSONSchemaParser)

  static void Initialize(Environment* env, v8::Local<v8::Object> target);
  static void New(const v8::FunctionCallbackInfo<v8::Value>& args);
  static void Parse(const v8::FunctionCallbackInfo<v8::Value>& args);

  // Static method registration
  static void RegisterExternalReferences(ExternalReferenceRegistry* registry);

  // Parse a V8 object into our internal schema representation
  static std::unique_ptr<JSONSchemaStruct> ParseSchemaObject(
      v8::Isolate* isolate,
      v8::Local<v8::Context> context,
      v8::Local<v8::Object> schema_obj);

  // Validate that a schema object conforms to JSON Schema 2020-12
  static bool ValidateSchemaStructure(v8::Isolate* isolate,
                                      v8::Local<v8::Context> context,
                                      v8::Local<v8::Object> schema_obj);

  // Helper to validate the 'type' field in a schema
  static bool ValidateTypeField(v8::Isolate* isolate,
                                v8::Local<v8::Context> context,
                                v8::Local<v8::Value> type_val);

  // Helper methods for parsing different parts of the schema
  static void ParseTypeField(v8::Isolate* isolate,
                             v8::Local<v8::Context> context,
                             v8::Local<v8::Object> schema_obj,
                             JSONSchemaStruct* schema);
  static void AddTypeToSchema(std::string_view type, JSONSchemaStruct* schema);
  static void ParseObjectFields(v8::Isolate* isolate,
                                v8::Local<v8::Context> context,
                                v8::Local<v8::Object> schema_obj,
                                JSONSchemaStruct* schema);
  static void ParseArrayFields(v8::Isolate* isolate,
                               v8::Local<v8::Context> context,
                               v8::Local<v8::Object> schema_obj,
                               JSONSchemaStruct* schema);
  static void ParseStringFields(v8::Isolate* isolate,
                                v8::Local<v8::Context> context,
                                v8::Local<v8::Object> schema_obj,
                                JSONSchemaStruct* schema);
  static void ParseNumberFields(v8::Isolate* isolate,
                                v8::Local<v8::Context> context,
                                v8::Local<v8::Object> schema_obj,
                                JSONSchemaStruct* schema);
  static void ParseLogicalFields(v8::Isolate* isolate,
                                 v8::Local<v8::Context> context,
                                 v8::Local<v8::Object> schema_obj,
                                 JSONSchemaStruct* schema);
  static void ParseConditionalFields(v8::Isolate* isolate,
                                     v8::Local<v8::Context> context,
                                     v8::Local<v8::Object> schema_obj,
                                     JSONSchemaStruct* schema);
  static void ParseSchemaArray(
      v8::Isolate* isolate,
      v8::Local<v8::Context> context,
      v8::Local<v8::Object> schema_obj,
      const char* key_name,
      std::vector<std::unique_ptr<JSONSchemaStruct>>* target);

  static void ParseSizeConstraint(v8::Isolate* isolate,
                                  v8::Local<v8::Context> context,
                                  v8::Local<v8::Object> obj,
                                  const char* prop_name,
                                  size_t* target,
                                  size_t default_value);

  static void ParseDoubleConstraint(v8::Isolate* isolate,
                                    v8::Local<v8::Context> context,
                                    v8::Local<v8::Object> obj,
                                    const char* prop_name,
                                    double* target,
                                    double default_value);

 private:
  explicit JSONSchemaParser(Environment* env, v8::Local<v8::Object> object);
  ~JSONSchemaParser() override = default;

  // Parse JSON data against the stored schema
  v8::MaybeLocal<v8::Value> ParseJSON(v8::Local<v8::Context> context,
                                      const std::string& json_string);

  // Recursive function to parse and validate JSON values
  template <typename T>
  v8::MaybeLocal<v8::Value> ParseJSONValue(v8::Local<v8::Context> context,
                                           T* element,
                                           const JSONSchemaStruct* schema,
                                           bool skip_validation = false);

  // Validation helper functions
  bool ValidateStringConstraints(v8::Isolate* isolate,
                                 const JSONSchemaStruct* schema,
                                 const std::string_view& value);

  bool ValidateNumberConstraints(v8::Isolate* isolate,
                                 const JSONSchemaStruct* schema,
                                 double value);

  std::unique_ptr<JSONSchemaStruct> schema_;
  Environment* env_;
};

}  // namespace json_schema_parser
}  // namespace node

#endif  // defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS
#endif  // SRC_NODE_JSON_SCHEMA_PARSER_H_
