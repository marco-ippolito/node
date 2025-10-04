#include "node_json_schema_parser.h"
#include "env-inl.h"
#include "node_errors.h"
#include "node_external_reference.h"
#include "simdjson.h"
#include "util-inl.h"
#include "v8.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <set>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace node {
namespace json_schema_parser {

using v8::Array;
using v8::Boolean;
using v8::Context;
using v8::Exception;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Isolate;
using v8::Local;
using v8::MaybeLocal;
using v8::Number;
using v8::Object;
using v8::ObjectTemplate;
using v8::String;
using v8::Value;

JSONSchemaParser::JSONSchemaParser(Environment* env, Local<Object> object)
    : BaseObject(env, object), env_(env) {}

void JSONSchemaParser::Initialize(Environment* env, Local<Object> target) {
  Isolate* isolate = env->isolate();
  Local<Context> context = env->context();

  Local<FunctionTemplate> tmpl = NewFunctionTemplate(isolate, New);
  tmpl->SetClassName(OneByteString(isolate, "JSONSchemaParser"));

  Local<ObjectTemplate> instance_tmpl = tmpl->InstanceTemplate();
  instance_tmpl->SetInternalFieldCount(BaseObject::kInternalFieldCount);

  SetProtoMethod(isolate, tmpl, "parse", Parse);

  SetConstructorFunction(context,
                         target,
                         "JSONSchemaParser",
                         tmpl,
                         SetConstructorFunctionFlag::NONE);
}

void JSONSchemaParser::New(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = env->isolate();
  Local<Context> context = env->context();

  if (!args.IsConstructCall()) {
    THROW_ERR_CONSTRUCT_CALL_REQUIRED(isolate);
    return;
  }

  if (args.Length() < 1 || !args[0]->IsObject()) {
    THROW_ERR_INVALID_ARG_TYPE(isolate,
                               "The \"schema\" argument must be an object");
    return;
  }

  Local<Object> schema_obj = args[0].As<Object>();

  // Validate schema structure
  if (!ValidateSchemaStructure(isolate, context, schema_obj)) {
    THROW_ERR_INVALID_ARG_VALUE(isolate, "Invalid JSON Schema");
    return;
  }

  // Parse schema into internal representation
  auto schema = ParseSchemaObject(isolate, context, schema_obj);
  if (!schema) {
    THROW_ERR_INVALID_ARG_VALUE(isolate, "Failed to parse JSON Schema");
    return;
  }

  auto* parser = new JSONSchemaParser(env, args.This());
  parser->schema_ = std::move(schema);
}

void JSONSchemaParser::Parse(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = env->isolate();
  Local<Context> context = env->context();

  JSONSchemaParser* parser;
  ASSIGN_OR_RETURN_UNWRAP(&parser, args.This());

  if (args.Length() < 1 || !args[0]->IsString()) {
    THROW_ERR_INVALID_ARG_TYPE(isolate,
                               "The \"json\" argument must be a string");
    return;
  }

  // Parse options if provided
  bool skip_validation = false;
  if (args.Length() >= 2 && args[1]->IsObject()) {
    Local<Object> options = args[1].As<Object>();
    Local<Value> skip_val;
    if (options->Get(context, OneByteString(isolate, "skipValidation"))
            .ToLocal(&skip_val) &&
        skip_val->IsBoolean()) {
      skip_validation = skip_val->BooleanValue(isolate);
    }
  }

  Utf8Value json_string(isolate, args[0]);
  std::string json_str = json_string.ToString();

  simdjson::ondemand::parser json_parser;

  simdjson::ondemand::document doc;
  if (json_parser.iterate(simdjson::pad(json_str)).get(doc)) {
    // TODO(marco-ippolito): simdjson may be too lenient and not catch all
    // invalid JSON cases like unquoted keys or incomplete JSON that should
    // throw SyntaxError
    isolate->ThrowException(
        Exception::SyntaxError(OneByteString(isolate, "Invalid JSON format")));
    return;
  }

  // Use the unified template function for both document and value
  Local<Value> result;
  if (!parser->ParseJSONValue(context, &doc, parser->schema_.get(), skip_validation)
           .ToLocal(&result)) {
    return;  // Exception already thrown
  }

  args.GetReturnValue().Set(result);
}

bool JSONSchemaParser::ValidateSchemaStructure(Isolate* isolate,
                                               Local<Context> context,
                                               Local<Object> schema_obj) {
  // Check if 'type' exists and is valid
  Local<Value> type_val;
  if (schema_obj->Get(context, OneByteString(isolate, "type"))
          .ToLocal(&type_val) &&
      !type_val->IsUndefined()) {
    if (!ValidateTypeField(isolate, context, type_val)) {
      return false;
    }
  }

  // Validate 'properties' if it exists (for object schemas)
  Local<Value> properties_val;
  if (schema_obj->Get(context, OneByteString(isolate, "properties"))
          .ToLocal(&properties_val) &&
      !properties_val->IsUndefined()) {
    if (!properties_val->IsObject()) {
      return false;
    }

    Local<Object> properties_obj = properties_val.As<Object>();
    Local<Array> prop_names;
    if (!properties_obj->GetOwnPropertyNames(context).ToLocal(&prop_names)) {
      return false;
    }

    for (uint32_t i = 0; i < prop_names->Length(); i++) {
      Local<Value> prop_name;
      Local<Value> prop_schema;
      if (!prop_names->Get(context, i).ToLocal(&prop_name) ||
          !prop_name->IsString() ||
          !properties_obj->Get(context, prop_name).ToLocal(&prop_schema)) {
        return false;
      }

      if (!prop_schema->IsObject()) {
        return false;
      }

      // Recursively validate the property schema
      if (!ValidateSchemaStructure(
              isolate, context, prop_schema.As<Object>())) {
        return false;
      }
    }
  }

  // Validate 'items' if it exists (for array schemas)
  Local<Value> items_val;
  if (schema_obj->Get(context, OneByteString(isolate, "items"))
          .ToLocal(&items_val) &&
      !items_val->IsUndefined()) {
    if (!items_val->IsObject()) {
      return false;
    }

    // Recursively validate the items schema
    if (!ValidateSchemaStructure(isolate, context, items_val.As<Object>())) {
      return false;
    }
  }

  // Validate 'required' if it exists
  Local<Value> required_val;
  if (schema_obj->Get(context, OneByteString(isolate, "required"))
          .ToLocal(&required_val) &&
      !required_val->IsUndefined()) {
    if (!required_val->IsArray()) {
      return false;
    }

    Local<Array> required_array = required_val.As<Array>();
    for (uint32_t i = 0; i < required_array->Length(); i++) {
      Local<Value> required_prop;
      if (!required_array->Get(context, i).ToLocal(&required_prop) ||
          !required_prop->IsString()) {
        return false;
      }
    }
  }

  // Validate logical operators (allOf, anyOf, oneOf)
  constexpr std::array<std::string_view, 3> logical_ops = {
      "allOf", "anyOf", "oneOf"};
  for (const auto& op : logical_ops) {
    Local<Value> op_val;
    if (schema_obj->Get(context, OneByteString(isolate, op.data()))
            .ToLocal(&op_val) &&
        !op_val->IsUndefined()) {
      if (!op_val->IsArray()) {
        return false;
      }

      Local<Array> schemas_array = op_val.As<Array>();
      for (uint32_t i = 0; i < schemas_array->Length(); i++) {
        Local<Value> sub_schema;
        if (!schemas_array->Get(context, i).ToLocal(&sub_schema) ||
            !sub_schema->IsObject()) {
          return false;
        }

        // Recursively validate each sub-schema
        if (!ValidateSchemaStructure(
                isolate, context, sub_schema.As<Object>())) {
          return false;
        }
      }
    }
  }

  // Validate 'not' if it exists
  Local<Value> not_val;
  if (schema_obj->Get(context, OneByteString(isolate, "not"))
          .ToLocal(&not_val) &&
      !not_val->IsUndefined()) {
    if (!not_val->IsObject()) {
      return false;
    }

    // Recursively validate the not schema
    if (!ValidateSchemaStructure(isolate, context, not_val.As<Object>())) {
      return false;
    }
  }

  // Validate conditional schemas (if, then, else)
  constexpr std::array<std::string_view, 3> conditional_ops = {
      "if", "then", "else"};
  for (const auto& op : conditional_ops) {
    Local<Value> op_val;
    if (schema_obj->Get(context, OneByteString(isolate, op.data()))
            .ToLocal(&op_val) &&
        !op_val->IsUndefined()) {
      if (!op_val->IsObject()) {
        return false;
      }

      // Recursively validate the conditional schema
      if (!ValidateSchemaStructure(isolate, context, op_val.As<Object>())) {
        return false;
      }
    }
  }

  return true;
}

bool JSONSchemaParser::ValidateTypeField(Isolate* isolate,
                                         Local<Context> context,
                                         Local<Value> type_val) {
  constexpr std::array<std::string_view, 7> valid_types = {
      "string", "number", "integer", "boolean", "object", "array", "null"};

  if (type_val->IsString()) {
    Utf8Value type_str(isolate, type_val);
    std::string_view type = type_str.ToStringView();

    return std::find(valid_types.begin(), valid_types.end(), type) !=
           valid_types.end();
  } else if (type_val->IsArray()) {
    Local<Array> type_array = type_val.As<Array>();
    const uint32_t length = type_array->Length();
    if (length == 0) {
      return false;  // Empty type array is invalid
    }

    for (uint32_t i = 0; i < length; i++) {
      Local<Value> item;
      if (!type_array->Get(context, i).ToLocal(&item) || !item->IsString()) {
        return false;
      }
      Utf8Value type_str(isolate, item);
      std::string_view type = type_str.ToStringView();

      if (std::find(valid_types.begin(), valid_types.end(), type) ==
          valid_types.end()) {
        return false;
      }
    }
    return true;
  }

  return false;  // type must be string or array
}

std::unique_ptr<JSONSchemaStruct> JSONSchemaParser::ParseSchemaObject(
    Isolate* isolate, Local<Context> context, Local<Object> schema_obj) {
  auto schema = std::make_unique<JSONSchemaStruct>();

  // Parse 'type' field
  ParseTypeField(isolate, context, schema_obj, schema.get());

  // Parse object-related fields
  ParseObjectFields(isolate, context, schema_obj, schema.get());

  // Parse array-related fields
  ParseArrayFields(isolate, context, schema_obj, schema.get());

  // Parse string validation fields
  ParseStringFields(isolate, context, schema_obj, schema.get());

  // Parse number validation fields
  ParseNumberFields(isolate, context, schema_obj, schema.get());

  // Parse logical operators (allOf, anyOf, oneOf, not)
  ParseLogicalFields(isolate, context, schema_obj, schema.get());

  // Parse conditional fields (if, then, else)
  ParseConditionalFields(isolate, context, schema_obj, schema.get());

  return schema;
}

void JSONSchemaParser::ParseTypeField(Isolate* isolate,
                                      Local<Context> context,
                                      Local<Object> schema_obj,
                                      JSONSchemaStruct* schema) {
  Local<Value> type_val;
  if (!schema_obj->Get(context, OneByteString(isolate, "type"))
           .ToLocal(&type_val) ||
      type_val->IsUndefined()) {
    return;
  }

  if (type_val->IsString()) {
    Utf8Value type_str(isolate, type_val);
    std::string_view type = type_str.ToStringView();
    AddTypeToSchema(type, schema);
  } else if (type_val->IsArray()) {
    Local<Array> type_array = type_val.As<Array>();
    for (uint32_t i = 0; i < type_array->Length(); i++) {
      Local<Value> item;
      if (type_array->Get(context, i).ToLocal(&item) && item->IsString()) {
        Utf8Value type_str(isolate, item);
        std::string_view type = type_str.ToStringView();
        AddTypeToSchema(type, schema);
      }
    }
  }
}

void JSONSchemaParser::AddTypeToSchema(std::string_view type,
                                       JSONSchemaStruct* schema) {
  if (type == "string")
    schema->types.insert(JSONSchemaType::STRING);
  else if (type == "number")
    schema->types.insert(JSONSchemaType::NUMBER);
  else if (type == "integer")
    schema->types.insert(JSONSchemaType::INTEGER);
  else if (type == "boolean")
    schema->types.insert(JSONSchemaType::BOOLEAN);
  else if (type == "object")
    schema->types.insert(JSONSchemaType::OBJECT);
  else if (type == "array")
    schema->types.insert(JSONSchemaType::ARRAY);
  else if (type == "null")
    schema->types.insert(JSONSchemaType::NULL_TYPE);
  else
    UNREACHABLE();
}

void JSONSchemaParser::ParseObjectFields(Isolate* isolate,
                                         Local<Context> context,
                                         Local<Object> schema_obj,
                                         JSONSchemaStruct* schema) {
  // Parse 'properties'
  Local<Value> properties_val;
  if (schema_obj->Get(context, OneByteString(isolate, "properties"))
          .ToLocal(&properties_val) &&
      properties_val->IsObject()) {
    Local<Object> properties_obj = properties_val.As<Object>();
    Local<Array> prop_names;
    if (properties_obj->GetOwnPropertyNames(context).ToLocal(&prop_names)) {
      for (uint32_t i = 0; i < prop_names->Length(); i++) {
        Local<Value> prop_name;
        Local<Value> prop_schema;
        if (prop_names->Get(context, i).ToLocal(&prop_name) &&
            prop_name->IsString() &&
            properties_obj->Get(context, prop_name).ToLocal(&prop_schema) &&
            prop_schema->IsObject()) {
          Utf8Value prop_name_str(isolate, prop_name);
          auto parsed_prop_schema =
              ParseSchemaObject(isolate, context, prop_schema.As<Object>());
          if (parsed_prop_schema) {
            schema->properties[prop_name_str.ToString()] =
                std::move(parsed_prop_schema);
          }
        }
      }
    }
  }

  // Parse 'required'
  Local<Value> required_val;
  if (schema_obj->Get(context, OneByteString(isolate, "required"))
          .ToLocal(&required_val) &&
      required_val->IsArray()) {
    Local<Array> required_array = required_val.As<Array>();
    for (uint32_t i = 0; i < required_array->Length(); i++) {
      Local<Value> required_prop;
      if (required_array->Get(context, i).ToLocal(&required_prop) &&
          required_prop->IsString()) {
        Utf8Value required_str(isolate, required_prop);
        schema->required.insert(required_str.ToString());
      }
    }
  }

  // Parse minProperties, maxProperties
  ParseSizeConstraint(isolate,
                      context,
                      schema_obj,
                      "minProperties",
                      &schema->min_properties,
                      0);
  ParseSizeConstraint(isolate,
                      context,
                      schema_obj,
                      "maxProperties",
                      &schema->max_properties,
                      SIZE_MAX);
}

void JSONSchemaParser::ParseArrayFields(Isolate* isolate,
                                        Local<Context> context,
                                        Local<Object> schema_obj,
                                        JSONSchemaStruct* schema) {
  // Parse 'items'
  Local<Value> items_val;
  if (schema_obj->Get(context, OneByteString(isolate, "items"))
          .ToLocal(&items_val) &&
      items_val->IsObject()) {
    auto items_schema =
        ParseSchemaObject(isolate, context, items_val.As<Object>());
    if (items_schema) {
      schema->items = std::move(items_schema);
    }
  }

  // Parse minItems, maxItems
  ParseSizeConstraint(
      isolate, context, schema_obj, "minItems", &schema->min_items, 0);
  ParseSizeConstraint(
      isolate, context, schema_obj, "maxItems", &schema->max_items, SIZE_MAX);

  // Parse uniqueItems
  Local<Value> unique_val;
  if (schema_obj->Get(context, OneByteString(isolate, "uniqueItems"))
          .ToLocal(&unique_val) &&
      unique_val->IsBoolean()) {
    schema->unique_items = unique_val->BooleanValue(isolate);
  }
}

void JSONSchemaParser::ParseStringFields(Isolate* isolate,
                                         Local<Context> context,
                                         Local<Object> schema_obj,
                                         JSONSchemaStruct* schema) {
  // Parse minLength, maxLength
  ParseSizeConstraint(
      isolate, context, schema_obj, "minLength", &schema->min_length, 0);
  ParseSizeConstraint(
      isolate, context, schema_obj, "maxLength", &schema->max_length, SIZE_MAX);

  // Parse pattern
  Local<Value> pattern_val;
  if (schema_obj->Get(context, OneByteString(isolate, "pattern"))
          .ToLocal(&pattern_val) &&
      pattern_val->IsString()) {
    Utf8Value pattern_str(isolate, pattern_val);
    schema->pattern = std::string(*pattern_str);
  }

  // Parse format
  Local<Value> format_val;
  if (schema_obj->Get(context, OneByteString(isolate, "format"))
          .ToLocal(&format_val) &&
      format_val->IsString()) {
    Utf8Value format_str(isolate, format_val);
    schema->format = std::string(*format_str);
  }
}

void JSONSchemaParser::ParseNumberFields(Isolate* isolate,
                                         Local<Context> context,
                                         Local<Object> schema_obj,
                                         JSONSchemaStruct* schema) {
  // Parse minimum, maximum
  ParseDoubleConstraint(
      isolate, context, schema_obj, "minimum", &schema->minimum, -INFINITY);
  ParseDoubleConstraint(
      isolate, context, schema_obj, "maximum", &schema->maximum, INFINITY);
  ParseDoubleConstraint(isolate,
                        context,
                        schema_obj,
                        "exclusiveMinimum",
                        &schema->exclusive_minimum,
                        -INFINITY);
  ParseDoubleConstraint(isolate,
                        context,
                        schema_obj,
                        "exclusiveMaximum",
                        &schema->exclusive_maximum,
                        INFINITY);
  ParseDoubleConstraint(
      isolate, context, schema_obj, "multipleOf", &schema->multiple_of, 0);
}

void JSONSchemaParser::ParseLogicalFields(Isolate* isolate,
                                          Local<Context> context,
                                          Local<Object> schema_obj,
                                          JSONSchemaStruct* schema) {
  // Parse allOf, anyOf, oneOf
  ParseSchemaArray(isolate, context, schema_obj, "allOf", &schema->all_of);
  ParseSchemaArray(isolate, context, schema_obj, "anyOf", &schema->any_of);
  ParseSchemaArray(isolate, context, schema_obj, "oneOf", &schema->one_of);

  // Parse not
  Local<Value> not_val;
  if (schema_obj->Get(context, OneByteString(isolate, "not"))
          .ToLocal(&not_val) &&
      not_val->IsObject()) {
    schema->not_schema =
        ParseSchemaObject(isolate, context, not_val.As<Object>());
  }
}

void JSONSchemaParser::ParseConditionalFields(Isolate* isolate,
                                              Local<Context> context,
                                              Local<Object> schema_obj,
                                              JSONSchemaStruct* schema) {
  // Parse if, then, else
  Local<Value> if_val;
  if (schema_obj->Get(context, OneByteString(isolate, "if")).ToLocal(&if_val) &&
      if_val->IsObject()) {
    schema->if_schema =
        ParseSchemaObject(isolate, context, if_val.As<Object>());
  }

  Local<Value> then_val;
  if (schema_obj->Get(context, OneByteString(isolate, "then"))
          .ToLocal(&then_val) &&
      then_val->IsObject()) {
    schema->then_schema =
        ParseSchemaObject(isolate, context, then_val.As<Object>());
  }

  Local<Value> else_val;
  if (schema_obj->Get(context, OneByteString(isolate, "else"))
          .ToLocal(&else_val) &&
      else_val->IsObject()) {
    schema->else_schema =
        ParseSchemaObject(isolate, context, else_val.As<Object>());
  }
}

void JSONSchemaParser::ParseSchemaArray(
    Isolate* isolate,
    Local<Context> context,
    Local<Object> schema_obj,
    const char* key_name,
    std::vector<std::unique_ptr<JSONSchemaStruct>>* target) {
  Local<Value> val;
  if (!schema_obj->Get(context, OneByteString(isolate, key_name))
           .ToLocal(&val) ||
      !val->IsArray()) {
    return;
  }

  Local<Array> array = val.As<Array>();
  for (uint32_t i = 0; i < array->Length(); i++) {
    Local<Value> item;
    if (array->Get(context, i).ToLocal(&item) && item->IsObject()) {
      auto parsed_schema =
          ParseSchemaObject(isolate, context, item.As<Object>());
      if (parsed_schema) {
        target->push_back(std::move(parsed_schema));
      }
    }
  }
}

void JSONSchemaParser::ParseSizeConstraint(Isolate* isolate,
                                           Local<Context> context,
                                           Local<Object> obj,
                                           const char* prop_name,
                                           size_t* target,
                                           size_t default_value) {
  Local<Value> prop_value;
  if (obj->Get(context, OneByteString(isolate, prop_name))
          .ToLocal(&prop_value) &&
      prop_value->IsNumber()) {
    double num_value =
        prop_value->NumberValue(context).FromMaybe(default_value);
    if (num_value >= 0) {
      *target = static_cast<size_t>(num_value);
    } else {
      *target = default_value;
    }
  } else {
    *target = default_value;
  }
}

void JSONSchemaParser::ParseDoubleConstraint(Isolate* isolate,
                                             Local<Context> context,
                                             Local<Object> obj,
                                             const char* prop_name,
                                             double* target,
                                             double default_value) {
  Local<Value> prop_value;
  if (obj->Get(context, OneByteString(isolate, prop_name))
          .ToLocal(&prop_value) &&
      prop_value->IsNumber()) {
    *target = prop_value->NumberValue(context).FromMaybe(default_value);
  } else {
    *target = default_value;
  }
}

template <typename T>
MaybeLocal<Value> JSONSchemaParser::ParseJSONValue(
    Local<Context> context, T* element, const JSONSchemaStruct* schema, bool skip_validation) {
  Isolate* isolate = context->GetIsolate();

  // Get the type first
  simdjson::ondemand::json_type json_type;
  if (element->type().get(json_type)) {
    isolate->ThrowException(
        Exception::SyntaxError(OneByteString(isolate, "Invalid JSON format")));
    return MaybeLocal<Value>();
  }

  // Convert based on actual type and validate constraints
  switch (json_type) {
    case simdjson::ondemand::json_type::string: {
      // Check type constraints if specified
      if (!skip_validation && !schema->types.empty() &&
          schema->types.count(JSONSchemaType::STRING) == 0) {
        isolate->ThrowException(Exception::TypeError(
            OneByteString(isolate, "Value does not match schema type")));
        return MaybeLocal<Value>();
      }
      std::string_view str_view;
      if (element->get_string().get(str_view)) {
        isolate->ThrowException(Exception::Error(
            OneByteString(isolate, "Failed to get string value")));
        return MaybeLocal<Value>();
      }

      // Validate string constraints
      if (!skip_validation && !ValidateStringConstraints(isolate, schema, str_view)) {
        return MaybeLocal<Value>();
      }

      return String::NewFromUtf8(isolate,
                                 str_view.data(),
                                 v8::NewStringType::kNormal,
                                 str_view.length())
          .ToLocalChecked();
    }

    case simdjson::ondemand::json_type::number: {
      // Check type constraints if specified
      if (!skip_validation && !schema->types.empty() &&
          schema->types.count(JSONSchemaType::NUMBER) == 0 &&
          schema->types.count(JSONSchemaType::INTEGER) == 0) {
        isolate->ThrowException(Exception::TypeError(
            OneByteString(isolate, "Value does not match schema type")));
        return MaybeLocal<Value>();
      }

      // Try to get as int64 first, then double
      int64_t int_val;
      if (!element->get_int64().get(int_val)) {
        double num_value = static_cast<double>(int_val);

        // Validate number constraints
        if (!skip_validation && !ValidateNumberConstraints(isolate, schema, num_value)) {
          return MaybeLocal<Value>();
        }

        return Number::New(isolate, num_value);
      }

      double double_val;
      if (!element->get_double().get(double_val)) {
        // If schema requires integer type and value is not a whole number,
        // reject
        if (!skip_validation && !schema->types.empty() &&
            schema->types.count(JSONSchemaType::INTEGER) > 0 &&
            schema->types.count(JSONSchemaType::NUMBER) == 0 &&
            std::floor(double_val) != double_val) {
          isolate->ThrowException(Exception::TypeError(
              OneByteString(isolate, "Value does not match schema type")));
          return MaybeLocal<Value>();
        }

        // Validate number constraints
        if (!skip_validation && !ValidateNumberConstraints(isolate, schema, double_val)) {
          return MaybeLocal<Value>();
        }

        return Number::New(isolate, double_val);
      }

      isolate->ThrowException(Exception::Error(
          OneByteString(isolate, "Failed to get number value")));
      return MaybeLocal<Value>();
    }

    case simdjson::ondemand::json_type::boolean: {
      // Check type constraints if specified
      if (!skip_validation && !schema->types.empty() &&
          schema->types.count(JSONSchemaType::BOOLEAN) == 0) {
        isolate->ThrowException(Exception::TypeError(
            OneByteString(isolate, "Value does not match schema type")));
        return MaybeLocal<Value>();
      }

      bool bool_val;
      if (element->get_bool().get(bool_val)) {
        isolate->ThrowException(Exception::Error(
            OneByteString(isolate, "Failed to get boolean value")));
        return MaybeLocal<Value>();
      }
      return Boolean::New(isolate, bool_val);
    }

    case simdjson::ondemand::json_type::object: {
      // Check type constraints if specified
      if (!skip_validation && !schema->types.empty() &&
          schema->types.count(JSONSchemaType::OBJECT) == 0) {
        isolate->ThrowException(Exception::TypeError(
            OneByteString(isolate, "Value does not match schema type")));
        return MaybeLocal<Value>();
      }

      simdjson::ondemand::object json_obj;
      if (element->get_object().get(json_obj)) {
        isolate->ThrowException(
            Exception::Error(OneByteString(isolate, "Failed to get object")));
        return MaybeLocal<Value>();
      }

      Local<Object> obj = Object::New(isolate);
      size_t property_count = 0;
      
      if (skip_validation) {
        for (auto field : json_obj) {
          std::string_view key;
          if (field.unescaped_key().get(key)) continue;
          
          simdjson::ondemand::value value;
          if (field.value().get(value)) continue;
          
          static JSONSchemaStruct default_schema;
          Local<Value> v8_value;
          if (!ParseJSONValue(context, &value, &default_schema, true).ToLocal(&v8_value)) {
            return MaybeLocal<Value>();
          }

          USE(obj->Set(context,
                       OneByteString(isolate, key.data(), key.length()),
                       v8_value));
          property_count++;
        }
      } else {
        std::unordered_set<std::string_view> found_properties;
        
        // Parse each property
        for (auto field : json_obj) {
          std::string_view key;
          if (field.unescaped_key().get(key)) continue;
          
          found_properties.insert(key);
          property_count++;
          
          Local<String> v8_key = OneByteString(isolate, key.data(), key.length());
          
          simdjson::ondemand::value value;
          if (field.value().get(value)) continue;
          
          // Check if this property has a specific schema
          const JSONSchemaStruct* prop_schema = nullptr;
          auto prop_it = schema->properties.find(std::string(key));
          if (prop_it != schema->properties.end()) {
            prop_schema = prop_it->second.get();
          }
          
          // Use default permissive schema if no property schema specified
          static JSONSchemaStruct default_schema;
          if (!prop_schema) {
            prop_schema = &default_schema;
          }
          
          Local<Value> v8_value;
          if (!ParseJSONValue(context, &value, prop_schema, false).ToLocal(&v8_value)) {
            return MaybeLocal<Value>();
          }
          
          if (obj->Set(context, v8_key, v8_value).IsNothing()) {
            return MaybeLocal<Value>();
          }
        }
        
        // Validate object property count constraints
        if (property_count < schema->min_properties) {
          isolate->ThrowException(Exception::Error(OneByteString(
              isolate, "Object has fewer properties than minProperties")));
          return MaybeLocal<Value>();
        }
        
        if (property_count > schema->max_properties) {
          isolate->ThrowException(Exception::Error(OneByteString(
              isolate, "Object has more properties than maxProperties")));
          return MaybeLocal<Value>();
        }
        
        for (const std::string& required_prop : schema->required) {
          if (found_properties.find(required_prop) == found_properties.end()) {
            std::string error_msg =
                "Required property '" + required_prop + "' is missing";
            isolate->ThrowException(Exception::Error(
                OneByteString(isolate, error_msg.c_str())));
            return MaybeLocal<Value>();
          }
        }
      }

      return obj;
    }

    case simdjson::ondemand::json_type::array: {
      // Check type constraints if specified
      if (!skip_validation && !schema->types.empty() &&
          schema->types.count(JSONSchemaType::ARRAY) == 0) {
        isolate->ThrowException(Exception::TypeError(
            OneByteString(isolate, "Value does not match schema type")));
        return MaybeLocal<Value>();
      }

      simdjson::ondemand::array json_array;
      if (element->get_array().get(json_array)) {
        isolate->ThrowException(
            Exception::Error(OneByteString(isolate, "Failed to get array")));
        return MaybeLocal<Value>();
      }

      // We need to parse items directly without counting first due to ondemand
      // parser
      v8::LocalVector<v8::Value> items(isolate);
      
      if (skip_validation) {
        static JSONSchemaStruct default_schema;
        
        for (auto item : json_array) {
          simdjson::ondemand::value value;
          if (item.get(value)) {
            isolate->ThrowException(Exception::Error(
                OneByteString(isolate, "Failed to get array item")));
            return MaybeLocal<Value>();
          }
          
          Local<Value> v8_value;
          if (!ParseJSONValue(context, &value, &default_schema, true).ToLocal(&v8_value)) {
            return MaybeLocal<Value>();
          }
          
          items.push_back(v8_value);
        }
      } else {
        // Validation path
        std::unordered_set<std::string> seen_values;  // For uniqueItems validation
        
        // Get items schema
        const JSONSchemaStruct* items_schema = nullptr;
        if (std::holds_alternative<std::unique_ptr<JSONSchemaStruct>>(
                schema->items)) {
          items_schema =
              std::get<std::unique_ptr<JSONSchemaStruct>>(schema->items).get();
        }
        
        // Use default permissive schema if no items schema specified
        static JSONSchemaStruct default_schema;
        if (!items_schema) {
          items_schema = &default_schema;
        }
        
        for (auto item : json_array) {
          simdjson::ondemand::value value;
          if (item.get(value)) {
            isolate->ThrowException(Exception::Error(
                OneByteString(isolate, "Failed to get array item")));
            return MaybeLocal<Value>();
          }
          
          Local<Value> v8_value;
          if (!ParseJSONValue(context, &value, items_schema, false).ToLocal(&v8_value)) {
            return MaybeLocal<Value>();
          }
          
          // Check uniqueItems constraint
          if (schema->unique_items) {
            // Convert to string for comparison (simplified approach)
            String::Utf8Value utf8_value(isolate, v8_value);
            std::string str_value(*utf8_value);
            
            if (seen_values.count(str_value) > 0) {
              isolate->ThrowException(Exception::Error(
                  OneByteString(isolate, "Array contains duplicate items")));
              return MaybeLocal<Value>();
            }
            seen_values.insert(str_value);
          }
          
          items.push_back(v8_value);
        }
        
        // Validate array length constraints
        size_t array_length = items.size();
        if (array_length < schema->min_items) {
          isolate->ThrowException(Exception::Error(OneByteString(
              isolate, "Array has fewer items than minItems")));
          return MaybeLocal<Value>();
        }
        
        if (array_length > schema->max_items) {
          isolate->ThrowException(Exception::Error(OneByteString(
              isolate, "Array has more items than maxItems")));
          return MaybeLocal<Value>();
        }
      }

      // Create V8 array and populate it
      size_t count = items.size();
      Local<Array> arr = Array::New(isolate, count);
      for (size_t i = 0; i < count; i++) {
        if (arr->Set(context, static_cast<uint32_t>(i), items[i]).IsNothing()) {
          return MaybeLocal<Value>();
        }
      }

      return arr;
    }

    case simdjson::ondemand::json_type::null: {
      // Check type constraints if specified
      if (!skip_validation && !schema->types.empty() &&
          schema->types.count(JSONSchemaType::NULL_TYPE) == 0) {
        isolate->ThrowException(Exception::TypeError(
            OneByteString(isolate, "Value does not match schema type")));
        return MaybeLocal<Value>();
      }

      return v8::Null(isolate);
    }
  }

  // TODO(marco-ippolito): Implement logical operators (allOf, anyOf, oneOf,
  // not) Currently parsed but not validated during JSON processing Need to
  // implement post-validation logic for logical constraints

  UNREACHABLE();
}

// Helper function to validate string constraints
bool JSONSchemaParser::ValidateStringConstraints(
    v8::Isolate* isolate,
    const JSONSchemaStruct* schema,
    const std::string_view& value) {
  // For proper Unicode character counting, convert to V8 string first
  Local<String> v8_string;
  if (!String::NewFromUtf8(
           isolate, value.data(), v8::NewStringType::kNormal, value.length())
           .ToLocal(&v8_string)) {
    isolate->ThrowException(
        Exception::Error(OneByteString(isolate, "Invalid UTF-8 string")));
    return false;
  }

  // Get Unicode character count (not byte count)
  size_t char_count = static_cast<size_t>(v8_string->Length());

  if (char_count < schema->min_length) {
    isolate->ThrowException(Exception::Error(
        OneByteString(isolate, "String is shorter than minLength")));
    return false;
  }

  if (char_count > schema->max_length) {
    isolate->ThrowException(Exception::Error(
        OneByteString(isolate, "String is longer than maxLength")));
    return false;
  }

  return true;
}

// Helper function to validate number constraints
bool JSONSchemaParser::ValidateNumberConstraints(v8::Isolate* isolate,
                                                 const JSONSchemaStruct* schema,
                                                 double value) {
  // Check minimum constraint
  if (value < schema->minimum) {
    isolate->ThrowException(Exception::Error(
        OneByteString(isolate, "Number is less than minimum")));
    return false;
  }

  // Check maximum constraint
  if (value > schema->maximum) {
    isolate->ThrowException(Exception::Error(
        OneByteString(isolate, "Number is greater than maximum")));
    return false;
  }

  // Check exclusive minimum constraint
  if (value <= schema->exclusive_minimum) {
    isolate->ThrowException(Exception::Error(
        OneByteString(isolate, "Number is not greater than exclusiveMinimum")));
    return false;
  }

  // Check exclusive maximum constraint
  if (value >= schema->exclusive_maximum) {
    isolate->ThrowException(Exception::Error(
        OneByteString(isolate, "Number is not less than exclusiveMaximum")));
    return false;
  }

  // Check multipleOf constraint
  if (schema->multiple_of > 0) {
    double quotient = value / schema->multiple_of;
    if (std::floor(quotient) != quotient) {
      isolate->ThrowException(Exception::Error(
          OneByteString(isolate, "Number is not a multiple of multipleOf")));
      return false;
    }
  }

  return true;
}

void JSONSchemaParser::RegisterExternalReferences(
    ExternalReferenceRegistry* registry) {
  registry->Register(New);
  registry->Register(Parse);
}

}  // namespace json_schema_parser
}  // namespace node
