import '../common/index.mjs';
import { describe, it, todo } from 'node:test';
import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { JSONSchemaParser } from 'node:util';

describe('JSONSchemaParser JSON Schema 2020-12 Spec', () => {
  // ========================================
  // STRING TYPE VALIDATION
  // ========================================
  describe('String Type Validation', () => {
    it('should validate basic string type', () => {
      const schema = { type: 'string' };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('"hello"'), 'hello');
      strictEqual(parser.parse('""'), '');
      throws(() => parser.parse('123'), { name: 'TypeError' });
      throws(() => parser.parse('true'), { name: 'TypeError' });
      throws(() => parser.parse('null'), { name: 'TypeError' });
      throws(() => parser.parse('{}'), { name: 'TypeError' });
      throws(() => parser.parse('[]'), { name: 'TypeError' });
    });

    it('should validate string length constraints', () => {
      const minLengthSchema = { type: 'string', minLength: 2 };
      const maxLengthSchema = { type: 'string', maxLength: 3 };
      const combinedSchema = { type: 'string', minLength: 2, maxLength: 4 };

      const minParser = new JSONSchemaParser(minLengthSchema);
      const maxParser = new JSONSchemaParser(maxLengthSchema);
      const combinedParser = new JSONSchemaParser(combinedSchema);

      // Valid cases
      strictEqual(minParser.parse('"ab"'), 'ab');
      strictEqual(maxParser.parse('"abc"'), 'abc');
      strictEqual(combinedParser.parse('"abc"'), 'abc');

      // Invalid cases
      throws(() => minParser.parse('"a"'), { name: 'Error' });
      throws(() => maxParser.parse('"abcd"'), { name: 'Error' });
      throws(() => combinedParser.parse('"a"'), { name: 'Error' });
      throws(() => combinedParser.parse('"abcde"'), { name: 'Error' });
    });

    it('should handle unicode strings correctly', () => {
      const schema = { type: 'string', minLength: 1, maxLength: 5 };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('"🌟"'), '🌟');
      strictEqual(parser.parse('"café"'), 'café');
      strictEqual(parser.parse('"αβγδε"'), 'αβγδε');

      throws(() => parser.parse('"🌟🌟🌟🌟🌟🌟"'), { name: 'Error' });
    });

    todo('should validate string patterns with regex', () => {
      const schema = { type: 'string', pattern: '^[a-zA-Z0-9]+$' };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('"abc123"'), 'abc123');
      throws(() => parser.parse('"hello world"'), { name: 'Error' });
    });

    todo('should validate string format constraints', () => {
      const emailSchema = { type: 'string', format: 'email' };
      const dateSchema = { type: 'string', format: 'date-time' };
      const uriSchema = { type: 'string', format: 'uri' };

      const emailParser = new JSONSchemaParser(emailSchema);
      const dateParser = new JSONSchemaParser(dateSchema);
      const uriParser = new JSONSchemaParser(uriSchema);

      strictEqual(emailParser.parse('"user@example.com"'), 'user@example.com');
      strictEqual(dateParser.parse('"2023-01-01T00:00:00Z"'), '2023-01-01T00:00:00Z');
      strictEqual(uriParser.parse('"https://example.com"'), 'https://example.com');

      throws(() => emailParser.parse('"invalid-email"'), { name: 'Error' });
      throws(() => dateParser.parse('"invalid-date"'), { name: 'Error' });
      throws(() => uriParser.parse('"not-a-uri"'), { name: 'Error' });
    });

    todo('should validate string enum values', () => {
      const schema = { type: 'string', enum: ['red', 'green', 'blue'] };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('"red"'), 'red');
      strictEqual(parser.parse('"green"'), 'green');
      throws(() => parser.parse('"yellow"'), { name: 'Error' });
    });
  });

  // ========================================
  // NUMBER TYPE VALIDATION
  // ========================================
  describe('Number Type Validation', () => {
    it('should validate basic number type', () => {
      const schema = { type: 'number' };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('42'), 42);
      strictEqual(parser.parse('3.14'), 3.14);
      strictEqual(parser.parse('0'), 0);
      strictEqual(parser.parse('-1'), -1);
      throws(() => parser.parse('"123"'), { name: 'TypeError' });
      throws(() => parser.parse('true'), { name: 'TypeError' });
      throws(() => parser.parse('null'), { name: 'TypeError' });
    });

    it('should validate integer type', () => {
      const schema = { type: 'integer' };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('42'), 42);
      strictEqual(parser.parse('0'), 0);
      strictEqual(parser.parse('-1'), -1);
      // Floats should fail for integer type
      throws(() => parser.parse('3.14'), { name: 'TypeError' });
      throws(() => parser.parse('"123"'), { name: 'TypeError' });
    });

    it('should validate number range constraints', () => {
      const minSchema = { type: 'number', minimum: 0 };
      const maxSchema = { type: 'number', maximum: 10 };
      const exclusiveMinSchema = { type: 'number', exclusiveMinimum: 0 };
      const exclusiveMaxSchema = { type: 'number', exclusiveMaximum: 10 };
      const multipleSchema = { type: 'number', multipleOf: 5 };

      const minParser = new JSONSchemaParser(minSchema);
      const maxParser = new JSONSchemaParser(maxSchema);
      const exclusiveMinParser = new JSONSchemaParser(exclusiveMinSchema);
      const exclusiveMaxParser = new JSONSchemaParser(exclusiveMaxSchema);
      const multipleParser = new JSONSchemaParser(multipleSchema);

      // Valid cases
      strictEqual(minParser.parse('0'), 0);
      strictEqual(maxParser.parse('10'), 10);
      strictEqual(exclusiveMinParser.parse('0.1'), 0.1);
      strictEqual(exclusiveMaxParser.parse('9.9'), 9.9);
      strictEqual(multipleParser.parse('10'), 10);

      // Invalid cases
      throws(() => minParser.parse('-1'), { name: 'Error' });
      throws(() => maxParser.parse('11'), { name: 'Error' });
      throws(() => exclusiveMinParser.parse('0'), { name: 'Error' });
      throws(() => exclusiveMaxParser.parse('10'), { name: 'Error' });
      throws(() => multipleParser.parse('7'), { name: 'Error' });
    });

    it('should validate combined number constraints', () => {
      const schema = {
        type: 'number',
        minimum: 0,
        maximum: 100,
        multipleOf: 2
      };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('0'), 0);
      strictEqual(parser.parse('50'), 50);
      strictEqual(parser.parse('100'), 100);

      throws(() => parser.parse('-2'), { name: 'Error' });
      throws(() => parser.parse('102'), { name: 'Error' });
      throws(() => parser.parse('3'), { name: 'Error' });
    });

    todo('should validate number enum values', () => {
      const schema = { type: 'number', enum: [1, 2.5, 10, -5] };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('1'), 1);
      strictEqual(parser.parse('2.5'), 2.5);
      throws(() => parser.parse('3'), { name: 'Error' });
    });
  });

  // ========================================
  // BOOLEAN TYPE VALIDATION
  // ========================================
  describe('Boolean Type Validation', () => {
    it('should validate boolean type', () => {
      const schema = { type: 'boolean' };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('true'), true);
      strictEqual(parser.parse('false'), false);
      throws(() => parser.parse('1'), { name: 'TypeError' });
      throws(() => parser.parse('"true"'), { name: 'TypeError' });
      throws(() => parser.parse('null'), { name: 'TypeError' });
    });

    todo('should validate boolean enum values', () => {
      const schema = { type: 'boolean', enum: [true] };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('true'), true);
      throws(() => parser.parse('false'), { name: 'Error' });
    });
  });

  // ========================================
  // NULL TYPE VALIDATION
  // ========================================
  describe('Null Type Validation', () => {
    it('should validate null type', () => {
      const schema = { type: 'null' };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('null'), null);
      throws(() => parser.parse('0'), { name: 'TypeError' });
      throws(() => parser.parse('false'), { name: 'TypeError' });
      throws(() => parser.parse('""'), { name: 'TypeError' });
    });
  });

  // ========================================
  // ARRAY TYPE VALIDATION
  // ========================================
  describe('Array Type Validation', () => {
    it('should validate basic array type', () => {
      const schema = { type: 'array' };
      const parser = new JSONSchemaParser(schema);

      deepStrictEqual(parser.parse('[]'), []);
      deepStrictEqual(parser.parse('[1, 2, 3]'), [1, 2, 3]);
      throws(() => parser.parse('{}'), { name: 'TypeError' });
      throws(() => parser.parse('null'), { name: 'TypeError' });
      throws(() => parser.parse('"array"'), { name: 'TypeError' });
    });

    it('should validate array items with single schema', () => {
      const schema = {
        type: 'array',
        items: { type: 'string' }
      };
      const parser = new JSONSchemaParser(schema);

      deepStrictEqual(parser.parse('["hello", "world"]'), ['hello', 'world']);
      deepStrictEqual(parser.parse('[]'), []);

      throws(() => parser.parse('[123, "valid"]'), { name: 'TypeError' });
      throws(() => parser.parse('["valid", 123]'), { name: 'TypeError' });
    });

    it('should validate array items with mixed types', () => {
      const schema = {
        type: 'array',
        items: { type: ['string', 'number'] }
      };
      const parser = new JSONSchemaParser(schema);

      deepStrictEqual(parser.parse('["hello", 42, "world", 3.14]'), ['hello', 42, 'world', 3.14]);
      throws(() => parser.parse('["hello", true]'), { name: 'TypeError' });
    });

    it('should validate nested arrays', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'number' }
        }
      };
      const parser = new JSONSchemaParser(schema);

      deepStrictEqual(parser.parse('[[1, 2], [3, 4], []]'), [[1, 2], [3, 4], []]);
      throws(() => parser.parse('[[1, 2], ["invalid"]]'), { name: 'TypeError' });
    });

    todo('should validate array length constraints', () => {
      const minSchema = { type: 'array', minItems: 2 };
      const maxSchema = { type: 'array', maxItems: 3 };
      const combinedSchema = {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        items: { type: 'string' }
      };

      const minParser = new JSONSchemaParser(minSchema);
      const maxParser = new JSONSchemaParser(maxSchema);
      const combinedParser = new JSONSchemaParser(combinedSchema);

      deepStrictEqual(minParser.parse('[1, 2]'), [1, 2]);
      deepStrictEqual(maxParser.parse('[1, 2, 3]'), [1, 2, 3]);
      deepStrictEqual(combinedParser.parse('["a", "b"]'), ['a', 'b']);

      throws(() => minParser.parse('[1]'), { name: 'Error' });
      throws(() => maxParser.parse('[1, 2, 3, 4]'), { name: 'Error' });
      throws(() => combinedParser.parse('["a"]'), { name: 'Error' });
    });

    todo('should validate unique items constraint', () => {
      const schema = { type: 'array', uniqueItems: true };
      const parser = new JSONSchemaParser(schema);

      deepStrictEqual(parser.parse('[1, 2, 3]'), [1, 2, 3]);
      deepStrictEqual(parser.parse('["a", "b", "c"]'), ['a', 'b', 'c']);

      throws(() => parser.parse('[1, 1]'), { name: 'Error' });
      throws(() => parser.parse('["a", "b", "a"]'), { name: 'Error' });
    });

    todo('should validate tuple schemas with prefixItems', () => {
      const schema = {
        type: 'array',
        prefixItems: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' }
        ]
      };
      const parser = new JSONSchemaParser(schema);

      deepStrictEqual(parser.parse('["hello", 42, true]'), ['hello', 42, true]);
      throws(() => parser.parse('[42, "hello", true]'), { name: 'TypeError' });
    });

    todo('should validate contains constraint', () => {
      const schema = {
        type: 'array',
        contains: { type: 'string', minLength: 5 }
      };
      const parser = new JSONSchemaParser(schema);

      deepStrictEqual(parser.parse('["hello", 1, 2]'), ['hello', 1, 2]);
      throws(() => parser.parse('[1, 2, 3]'), { name: 'Error' });
    });
  });

  // ========================================
  // OBJECT TYPE VALIDATION
  // ========================================
  describe('Object Type Validation', () => {
    it('should validate basic object type', () => {
      const schema = { type: 'object' };
      const parser = new JSONSchemaParser(schema);

      deepStrictEqual(parser.parse('{}'), {});
      deepStrictEqual(parser.parse('{"key": "value"}'), { key: 'value' });
      throws(() => parser.parse('[]'), { name: 'TypeError' });
      throws(() => parser.parse('null'), { name: 'TypeError' });
      throws(() => parser.parse('"object"'), { name: 'TypeError' });
    });

    it('should validate object properties', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          active: { type: 'boolean' }
        }
      };
      const parser = new JSONSchemaParser(schema);

      const result = parser.parse('{"name": "John", "age": 30, "active": true}');
      strictEqual(result.name, 'John');
      strictEqual(result.age, 30);
      strictEqual(result.active, true);

      throws(() => parser.parse('{"name": 123}'), { name: 'TypeError' });
    });

    it('should validate required properties', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' }
        },
        required: ['name']
      };
      const parser = new JSONSchemaParser(schema);

      const result1 = parser.parse('{"name": "John", "age": 30}');
      strictEqual(result1.name, 'John');

      const result2 = parser.parse('{"name": "Jane"}');
      strictEqual(result2.name, 'Jane');

      throws(() => parser.parse('{"age": 30}'), {
        name: 'Error',
        message: /Required property 'name' is missing/
      });
    });

    it('should validate multiple required properties', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          age: { type: 'number' }
        },
        required: ['name', 'email']
      };
      const parser = new JSONSchemaParser(schema);

      const result = parser.parse('{"name": "John", "email": "john@example.com", "age": 30}');
      strictEqual(result.name, 'John');
      strictEqual(result.email, 'john@example.com');

      throws(() => parser.parse('{"name": "John", "age": 30}'), {
        message: /Required property 'email' is missing/
      });
    });

    it('should handle additional properties in objects', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' }
        },
        required: ['name']
      };
      const parser = new JSONSchemaParser(schema);

      const result = parser.parse('{"name": "test", "extra": "allowed"}');
      strictEqual(result.name, 'test');
      strictEqual(result.extra, 'allowed');
    });

    todo('should validate object property count constraints', () => {
      const minSchema = { type: 'object', minProperties: 2 };
      const maxSchema = { type: 'object', maxProperties: 2 };
      const combinedSchema = {
        type: 'object',
        minProperties: 1,
        maxProperties: 3,
        properties: {
          name: { type: 'string', minLength: 1 }
        },
        required: ['name']
      };

      const minParser = new JSONSchemaParser(minSchema);
      const maxParser = new JSONSchemaParser(maxSchema);
      const combinedParser = new JSONSchemaParser(combinedSchema);

      deepStrictEqual(minParser.parse('{"a": 1, "b": 2}'), { a: 1, b: 2 });
      deepStrictEqual(maxParser.parse('{"a": 1}'), { a: 1 });
      deepStrictEqual(combinedParser.parse('{"name": "John"}'), { name: 'John' });

      throws(() => minParser.parse('{"a": 1}'), { name: 'Error' });
      throws(() => maxParser.parse('{"a": 1, "b": 2, "c": 3}'), { name: 'Error' });
    });

    todo('should validate additionalProperties constraints', () => {
      const falseSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false
      };
      const schemaSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: { type: 'number' }
      };

      const falseParser = new JSONSchemaParser(falseSchema);
      const schemaParser = new JSONSchemaParser(schemaSchema);

      deepStrictEqual(falseParser.parse('{"name": "John"}'), { name: 'John' });
      deepStrictEqual(schemaParser.parse('{"name": "John", "age": 30}'), { name: 'John', age: 30 });

      throws(() => falseParser.parse('{"name": "John", "extra": "not allowed"}'), { name: 'Error' });
      throws(() => schemaParser.parse('{"name": "John", "extra": "not number"}'), { name: 'TypeError' });
    });

    todo('should validate patternProperties', () => {
      const schema = {
        type: 'object',
        patternProperties: {
          '^str_': { type: 'string' },
          '^num_': { type: 'number' }
        }
      };
      const parser = new JSONSchemaParser(schema);

      deepStrictEqual(parser.parse('{"str_name": "John", "num_age": 30}'), { str_name: 'John', num_age: 30 });
      throws(() => parser.parse('{"str_name": 123}'), { name: 'TypeError' });
    });
  });

  // ========================================
  // UNION TYPE VALIDATION
  // ========================================
  describe('Union Type Validation', () => {
    it('should validate multiple types (union)', () => {
      const schema = { type: ['string', 'number'] };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('"hello"'), 'hello');
      strictEqual(parser.parse('42'), 42);
      throws(() => parser.parse('true'), { name: 'TypeError' });
      throws(() => parser.parse('null'), { name: 'TypeError' });
      throws(() => parser.parse('{}'), { name: 'TypeError' });
    });

    todo('should validate mixed type enum values', () => {
      const schema = { enum: ['active', 1, true, null] };
      const parser = new JSONSchemaParser(schema);

      strictEqual(parser.parse('"active"'), 'active');
      strictEqual(parser.parse('1'), 1);
      strictEqual(parser.parse('true'), true);
      strictEqual(parser.parse('null'), null);

      throws(() => parser.parse('"inactive"'), { name: 'Error' });
      throws(() => parser.parse('0'), { name: 'Error' });
    });
  });
});

// ========================================
// LOGICAL OPERATORS (COMPOSITION)
// ========================================
describe('Logical Operators', () => {
  todo('should validate allOf (AND logic)', () => {
    const schema = {
      allOf: [
        { type: 'string' },
        { minLength: 2 },
        { maxLength: 5 }
      ]
    };
    const parser = new JSONSchemaParser(schema);

    strictEqual(parser.parse('"abc"'), 'abc');
    strictEqual(parser.parse('"abcde"'), 'abcde');

    throws(() => parser.parse('123'), { name: 'TypeError' });
    throws(() => parser.parse('"a"'), { name: 'Error' });
    throws(() => parser.parse('"abcdef"'), { name: 'Error' });
  });

  todo('should validate anyOf (OR logic)', () => {
    const schema = {
      anyOf: [
        { type: 'string', minLength: 5 },
        { type: 'number', minimum: 0 }
      ]
    };
    const parser = new JSONSchemaParser(schema);

    strictEqual(parser.parse('"hello"'), 'hello');
    strictEqual(parser.parse('42'), 42);

    throws(() => parser.parse('"hi"'), { name: 'Error' });
    throws(() => parser.parse('-1'), { name: 'Error' });
    throws(() => parser.parse('true'), { name: 'Error' });
  });

  todo('should validate oneOf (XOR logic)', () => {
    const schema = {
      oneOf: [
        { type: 'string', maxLength: 5 },
        { type: 'string', minLength: 3 }
      ]
    };
    const parser = new JSONSchemaParser(schema);

    strictEqual(parser.parse('"ab"'), 'ab');
    strictEqual(parser.parse('"abcdef"'), 'abcdef');

    throws(() => parser.parse('123'), { name: 'TypeError' });
    throws(() => parser.parse('"abc"'), { name: 'Error' }); // Matches both schemas
  });

  todo('should validate not (NOT logic)', () => {
    const schema = {
      not: { type: 'string' }
    };
    const parser = new JSONSchemaParser(schema);

    strictEqual(parser.parse('42'), 42);
    strictEqual(parser.parse('true'), true);
    strictEqual(parser.parse('null'), null);

    throws(() => parser.parse('"hello"'), { name: 'Error' });
  });

  todo('should validate complex logical combinations', () => {
    const schema = {
      allOf: [
        {
          anyOf: [
            { type: 'string' },
            { type: 'number' }
          ]
        },
        {
          not: { type: 'string', maxLength: 2 }
        }
      ]
    };
    const parser = new JSONSchemaParser(schema);

    strictEqual(parser.parse('"hello"'), 'hello');
    strictEqual(parser.parse('42'), 42);

    throws(() => parser.parse('true'), { name: 'Error' });
    throws(() => parser.parse('"hi"'), { name: 'Error' });
  });
});

// ========================================
// CONDITIONAL SCHEMAS
// ========================================
describe('Conditional Schemas', () => {
  todo('should validate if-then-else conditions', () => {
    const schema = {
      type: 'object',
      if: {
        properties: { type: { const: 'user' } }
      },
      then: {
        properties: {
          email: { type: 'string', format: 'email' }
        },
        required: ['email']
      },
      else: {
        properties: {
          apiKey: { type: 'string', minLength: 32 }
        },
        required: ['apiKey']
      }
    };
    const parser = new JSONSchemaParser(schema);

    deepStrictEqual(parser.parse('{"type": "user", "email": "user@example.com"}'),
      { type: 'user', email: 'user@example.com' });
    deepStrictEqual(parser.parse('{"type": "service", "apiKey": "abcdef1234567890abcdef1234567890"}'),
      { type: 'service', apiKey: 'abcdef1234567890abcdef1234567890' });

    throws(() => parser.parse('{"type": "user", "apiKey": "key"}'), { name: 'Error' });
  });

  todo('should validate dependentSchemas', () => {
    const schema = {
      type: 'object',
      dependentSchemas: {
        credit_card: {
          properties: {
            billing_address: { type: 'string' }
          },
          required: ['billing_address']
        }
      }
    };
    const parser = new JSONSchemaParser(schema);

    deepStrictEqual(parser.parse('{"payment": "cash"}'), { payment: 'cash' });
    deepStrictEqual(parser.parse('{"credit_card": "1234", "billing_address": "123 Main St"}'),
      { credit_card: '1234', billing_address: '123 Main St' });

    throws(() => parser.parse('{"credit_card": "1234"}'), { name: 'Error' });
  });
});

// ========================================
// NESTED STRUCTURES
// ========================================
describe('Nested Structures', () => {
  it('should validate complex nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            profile: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                preferences: {
                  type: 'object',
                  properties: {
                    theme: { type: 'string' },
                    notifications: { type: 'boolean' }
                  },
                  required: ['theme']
                }
              },
              required: ['name', 'preferences']
            }
          },
          required: ['profile']
        }
      },
      required: ['user']
    };
    const parser = new JSONSchemaParser(schema);

    const validData = {
      user: {
        profile: {
          name: 'Alice',
          preferences: {
            theme: 'dark',
            notifications: true
          }
        }
      }
    };

    const result = parser.parse(JSON.stringify(validData));
    strictEqual(result.user.profile.name, 'Alice');
    strictEqual(result.user.profile.preferences.theme, 'dark');

    throws(() => parser.parse('{"user": {"profile": {"name": "Alice", "preferences": {}}}}'), {
      message: /Required property 'theme' is missing/
    });
  });

  it('should validate arrays of objects', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' }
        },
        required: ['id', 'name']
      }
    };
    const parser = new JSONSchemaParser(schema);

    const validData = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' }
    ];

    const result = parser.parse(JSON.stringify(validData));
    strictEqual(result.length, 2);
    strictEqual(result[0].id, 1);
    strictEqual(result[1].name, 'Bob');

    throws(() => parser.parse('[{"id": 1, "name": "Alice"}, {"name": "Bob"}]'), {
      message: /Required property 'id' is missing/
    });
  });

  it('should validate objects with array properties', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' }
        },
        scores: {
          type: 'array',
          items: { type: 'number' }
        }
      },
      required: ['tags']
    };
    const parser = new JSONSchemaParser(schema);

    const validData = {
      tags: ['javascript', 'nodejs', 'json'],
      scores: [85, 92, 78]
    };

    const result = parser.parse(JSON.stringify(validData));
    deepStrictEqual(result.tags, ['javascript', 'nodejs', 'json']);
    deepStrictEqual(result.scores, [85, 92, 78]);

    throws(() => parser.parse('{"tags": ["valid", 123]}'), { name: 'TypeError' });
  });

  it('should handle deeply nested structures', () => {
    const schema = {
      type: 'object',
      properties: {
        level1: {
          type: 'object',
          properties: {
            level2: {
              type: 'object',
              properties: {
                level3: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string' }
                    },
                    required: ['value']
                  }
                }
              },
              required: ['level3']
            }
          },
          required: ['level2']
        }
      },
      required: ['level1']
    };
    const parser = new JSONSchemaParser(schema);

    const deepData = {
      level1: {
        level2: {
          level3: [
            { value: 'first' },
            { value: 'second' }
          ]
        }
      }
    };

    const result = parser.parse(JSON.stringify(deepData));
    strictEqual(result.level1.level2.level3[0].value, 'first');
    strictEqual(result.level1.level2.level3[1].value, 'second');
  });
});

// ========================================
// EDGE CASES AND COMPLIANCE
// ========================================
describe('Edge Cases and Compliance', () => {
  it('should handle empty schemas', () => {
    const schema = {};
    const parser = new JSONSchemaParser(schema);

    strictEqual(parser.parse('"string"'), 'string');
    strictEqual(parser.parse('42'), 42);
    strictEqual(parser.parse('true'), true);
    strictEqual(parser.parse('null'), null);
    deepStrictEqual(parser.parse('[]'), []);
    deepStrictEqual(parser.parse('{}'), {});
  });

  it('should handle schemas with no type constraint', () => {
    const schema = {
      properties: {
        name: { type: 'string' }
      }
    };
    const parser = new JSONSchemaParser(schema);

    strictEqual(parser.parse('"string"'), 'string');
    strictEqual(parser.parse('42'), 42);

    const result = parser.parse('{"name": "test"}');
    strictEqual(result.name, 'test');

    throws(() => parser.parse('{"name": 123}'), { name: 'TypeError' });
  });

  todo('should throw SyntaxError for invalid JSON', () => {
    const schema = { type: 'object' };
    const parser = new JSONSchemaParser(schema);

    throws(() => parser.parse('{ "key": }'), {
      name: 'SyntaxError',
      message: /Invalid JSON/
    });

    throws(() => parser.parse('{ key: "value" }'), { name: 'SyntaxError' });
    throws(() => parser.parse('invalid json'), { name: 'SyntaxError' });
  });

  it('should validate constructor parameters', () => {
    throws(() => new JSONSchemaParser({ type: 'invalid_type' }), {
      name: 'TypeError',
      message: /Invalid JSON Schema/
    });

    throws(() => new JSONSchemaParser(), {
      name: 'TypeError',
      message: /The "schema" argument must be an object/
    });

    throws(() => new JSONSchemaParser('not an object'), {
      name: 'TypeError',
      message: /The "schema" argument must be an object/
    });
  });
});

// ========================================
// REAL-WORLD PATTERNS
// ========================================
describe('Real-world Patterns', () => {
  it('should validate API response schema', () => {
    const schema = {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              attributes: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 1 },
                  email: { type: 'string' },
                  created_at: { type: 'string' }
                },
                required: ['name', 'email']
              }
            },
            required: ['id', 'type', 'attributes']
          }
        },
        meta: {
          type: 'object',
          properties: {
            total: { type: 'number', minimum: 0 },
            page: { type: 'number', minimum: 1 }
          },
          required: ['total']
        }
      },
      required: ['data', 'meta']
    };
    const parser = new JSONSchemaParser(schema);

    const validApiResponse = {
      data: [
        {
          id: '123',
          type: 'user',
          attributes: {
            name: 'John Doe',
            email: 'john@example.com',
            created_at: '2023-01-01T00:00:00Z'
          }
        }
      ],
      meta: {
        total: 1,
        page: 1
      }
    };

    const result = parser.parse(JSON.stringify(validApiResponse));
    strictEqual(result.data[0].attributes.name, 'John Doe');
    strictEqual(result.meta.total, 1);
  });

  it('should validate configuration schema with conditional logic', () => {
    const schema = {
      type: 'object',
      properties: {
        environment: { type: 'string' },
        database: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            port: { type: 'number', minimum: 1, maximum: 65535 },
            ssl: { type: 'boolean' }
          },
          required: ['host', 'port']
        },
        features: {
          type: 'object',
          properties: {
            logging: { type: 'boolean' },
            monitoring: { type: 'boolean' },
            cache: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                ttl: { type: 'number', minimum: 0 }
              },
              required: ['enabled']
            }
          },
          required: ['logging']
        }
      },
      required: ['environment', 'database']
    };
    const parser = new JSONSchemaParser(schema);

    const validConfig = {
      environment: 'production',
      database: {
        host: 'localhost',
        port: 5432,
        ssl: true
      },
      features: {
        logging: true,
        monitoring: true,
        cache: {
          enabled: true,
          ttl: 3600
        }
      }
    };

    const result = parser.parse(JSON.stringify(validConfig));
    strictEqual(result.environment, 'production');
    strictEqual(result.database.port, 5432);
    strictEqual(result.features.cache.ttl, 3600);
  });
});

// ========================================
// META-SCHEMA FEATURES
// ========================================
describe('Meta-Schema Features (Advanced)', () => {
  todo('should validate $ref references', () => {
    const schema = {
      type: 'object',
      properties: {
        user: { '$ref': '#/$defs/user' },
        admin: { '$ref': '#/$defs/user' }
      },
      '$defs': {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string', format: 'email' }
          },
          required: ['name', 'email']
        }
      }
    };
    const parser = new JSONSchemaParser(schema);

    const result = parser.parse('{"user": {"name": "John", "email": "john@example.com"}}');
    strictEqual(result.user.name, 'John');
  });

  todo('should validate $defs definitions', () => {
    const schema = {
      '$defs': {
        address: {
          type: 'object',
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
            zipcode: { type: 'string', pattern: '^\\d{5}$' }
          },
          required: ['street', 'city', 'zipcode']
        }
      },
      type: 'object',
      properties: {
        home: { '$ref': '#/$defs/address' },
        work: { '$ref': '#/$defs/address' }
      }
    };
    const parser = new JSONSchemaParser(schema);

    const result = parser.parse('{"home": {"street": "123 Main", "city": "NYC", "zipcode": "10001"}}');
    strictEqual(result.home.zipcode, '10001');
  });

  todo('should validate const values', () => {
    const schema = {
      type: 'object',
      properties: {
        version: { const: '1.0.0' },
        type: { const: 'user' }
      },
      required: ['version', 'type']
    };
    const parser = new JSONSchemaParser(schema);

    deepStrictEqual(parser.parse('{"version": "1.0.0", "type": "user"}'),
      { version: '1.0.0', type: 'user' });

    throws(() => parser.parse('{"version": "2.0.0", "type": "user"}'), { name: 'Error' });
  });
});
