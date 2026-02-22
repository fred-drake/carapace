import { describe, it, expect } from 'vitest';
import _Ajv, { type ErrorObject } from 'ajv';
// ajv ESM interop: default export is the constructor
const Ajv = _Ajv.default ?? _Ajv;
import { MANIFEST_JSON_SCHEMA } from './manifest-schema.js';

function createValidator() {
  const ajv = new Ajv({ strict: false });
  return ajv.compile(MANIFEST_JSON_SCHEMA);
}

function remindersManifest() {
  return {
    description: 'Manage Apple Reminders — create, list, complete, and delete reminders',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Fred Drake', url: 'https://freddrake.com' },
    provides: {
      channels: [],
      tools: [
        {
          name: 'create_reminder',
          description: 'Create a new reminder',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            required: ['title'],
            additionalProperties: false,
            properties: {
              title: { type: 'string', maxLength: 500 },
              due: { type: 'string', format: 'date-time' },
              list: { type: 'string', default: 'Personal' },
            },
          },
        },
      ],
    },
    subscribes: [],
    config_schema: {
      type: 'object',
      properties: {
        default_list: {
          type: 'string',
          description: 'Default reminders list to use',
        },
      },
    },
  };
}

function telegramManifest() {
  return {
    description: 'Send and receive messages via Telegram Bot API',
    version: '1.0.0',
    app_compat: '>=0.1.0',
    author: { name: 'Fred Drake', url: 'https://freddrake.com' },
    provides: {
      channels: ['telegram'],
      tools: [
        {
          name: 'send_telegram',
          description: 'Send a message via Telegram',
          risk_level: 'low',
          arguments_schema: {
            type: 'object',
            required: ['recipient', 'body'],
            additionalProperties: false,
            properties: {
              recipient: { type: 'string' },
              body: { type: 'string', maxLength: 4096 },
            },
          },
        },
      ],
    },
    subscribes: ['message.inbound', 'task.triggered'],
    config_schema: {
      type: 'object',
      required: ['bot_token'],
      properties: {
        bot_token: {
          type: 'string',
          description: 'Telegram Bot API token',
        },
      },
    },
  };
}

describe('MANIFEST_JSON_SCHEMA', () => {
  it('compiles without errors', () => {
    expect(() => createValidator()).not.toThrow();
  });

  describe('valid manifests', () => {
    it('accepts the reminders manifest', () => {
      const validate = createValidator();
      const valid = validate(remindersManifest());
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });

    it('accepts the telegram manifest', () => {
      const validate = createValidator();
      const valid = validate(telegramManifest());
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });

    it('accepts a minimal manifest without config_schema', () => {
      const validate = createValidator();
      const valid = validate({
        description: 'Minimal plugin',
        version: '0.1.0',
        app_compat: '>=0.1.0',
        author: { name: 'Test' },
        provides: { channels: [], tools: [] },
        subscribes: [],
      });
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });

    it('accepts a manifest with allowed_groups', () => {
      const validate = createValidator();
      const valid = validate({
        ...remindersManifest(),
        allowed_groups: ['home-automation', 'personal'],
      });
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });

    it('accepts a manifest with install.credentials', () => {
      const validate = createValidator();
      const valid = validate({
        ...remindersManifest(),
        install: {
          credentials: [
            {
              key: 'API_KEY',
              description: 'Your API key',
              required: true,
              obtain_url: 'https://example.com/keys',
              format_hint: 'sk-...',
            },
            {
              key: 'WEBHOOK_SECRET',
              description: 'Optional webhook secret',
              required: false,
            },
          ],
        },
      });
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });

    it('accepts a manifest with install and empty credentials array', () => {
      const validate = createValidator();
      const valid = validate({
        ...remindersManifest(),
        install: { credentials: [] },
      });
      expect(validate.errors).toBeNull();
      expect(valid).toBe(true);
    });
  });

  describe('invalid manifests', () => {
    it('rejects a tool with additionalProperties not set to false', () => {
      const validate = createValidator();
      const manifest = remindersManifest();
      const badSchema = { ...manifest.provides.tools[0].arguments_schema };
      delete (badSchema as Record<string, unknown>).additionalProperties;
      manifest.provides.tools[0].arguments_schema = badSchema as any;

      expect(validate(manifest)).toBe(false);
      expect(validate.errors).not.toBeNull();
    });

    it('rejects a tool with additionalProperties set to true', () => {
      const validate = createValidator();
      const manifest = remindersManifest();
      (
        manifest.provides.tools[0].arguments_schema as Record<string, unknown>
      ).additionalProperties = true;

      expect(validate(manifest)).toBe(false);
    });

    it('rejects a manifest with extra properties at root level', () => {
      const validate = createValidator();
      const manifest = {
        ...remindersManifest(),
        unexpected_field: 'should not be here',
      };

      expect(validate(manifest)).toBe(false);
      expect(validate.errors!.some((e: ErrorObject) => e.keyword === 'additionalProperties')).toBe(
        true,
      );
    });

    it('rejects a manifest missing required fields', () => {
      const validate = createValidator();
      for (const field of [
        'description',
        'version',
        'provides',
        'subscribes',
        'author',
        'app_compat',
      ]) {
        const manifest = remindersManifest();
        delete (manifest as Record<string, unknown>)[field];
        expect(validate(manifest)).toBe(false);
      }
    });

    it('rejects a tool with invalid risk_level', () => {
      const validate = createValidator();
      const manifest = remindersManifest();
      (manifest.provides.tools[0] as Record<string, unknown>).risk_level = 'medium';

      expect(validate(manifest)).toBe(false);
    });

    it('rejects install.credentials with missing required fields', () => {
      const validate = createValidator();
      const manifest = {
        ...remindersManifest(),
        install: {
          credentials: [
            {
              key: 'API_KEY',
              // missing 'description' and 'required'
            },
          ],
        },
      };

      expect(validate(manifest)).toBe(false);
      expect(validate.errors).not.toBeNull();
    });

    it('rejects install with extra properties', () => {
      const validate = createValidator();
      const manifest = {
        ...remindersManifest(),
        install: {
          credentials: [],
          unexpected_field: 'nope',
        },
      };

      expect(validate(manifest)).toBe(false);
      expect(validate.errors!.some((e: ErrorObject) => e.keyword === 'additionalProperties')).toBe(
        true,
      );
    });

    it('rejects credential spec with extra properties', () => {
      const validate = createValidator();
      const manifest = {
        ...remindersManifest(),
        install: {
          credentials: [
            {
              key: 'API_KEY',
              description: 'Your API key',
              required: true,
              unexpected_field: 'nope',
            },
          ],
        },
      };

      expect(validate(manifest)).toBe(false);
      expect(validate.errors!.some((e: ErrorObject) => e.keyword === 'additionalProperties')).toBe(
        true,
      );
    });

    it('rejects install without credentials array', () => {
      const validate = createValidator();
      const manifest = {
        ...remindersManifest(),
        install: {},
      };

      expect(validate(manifest)).toBe(false);
    });
  });
});
