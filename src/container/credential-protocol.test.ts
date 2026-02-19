import { describe, it, expect } from 'vitest';
import {
  serializeCredentials,
  validateCredentialName,
  parseCredentialLine,
} from './credential-protocol.js';
import type { Credential } from './credential-protocol.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('credential-protocol', () => {
  // -----------------------------------------------------------------------
  // validateCredentialName
  // -----------------------------------------------------------------------

  describe('validateCredentialName', () => {
    it('accepts uppercase alphanumeric with underscores', () => {
      expect(validateCredentialName('ANTHROPIC_API_KEY')).toBe(true);
    });

    it('accepts single character names', () => {
      expect(validateCredentialName('A')).toBe(true);
    });

    it('accepts lowercase names', () => {
      expect(validateCredentialName('api_key')).toBe(true);
    });

    it('accepts mixed case names', () => {
      expect(validateCredentialName('My_Key_123')).toBe(true);
    });

    it('rejects empty string', () => {
      expect(validateCredentialName('')).toBe(false);
    });

    it('rejects names starting with a digit', () => {
      expect(validateCredentialName('1BAD')).toBe(false);
    });

    it('rejects names with spaces', () => {
      expect(validateCredentialName('MY KEY')).toBe(false);
    });

    it('rejects names with hyphens', () => {
      expect(validateCredentialName('MY-KEY')).toBe(false);
    });

    it('rejects names with equals sign', () => {
      expect(validateCredentialName('KEY=VALUE')).toBe(false);
    });

    it('rejects names with newlines', () => {
      expect(validateCredentialName('KEY\nNAME')).toBe(false);
    });

    it('rejects names with null bytes', () => {
      expect(validateCredentialName('KEY\0NAME')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // parseCredentialLine
  // -----------------------------------------------------------------------

  describe('parseCredentialLine', () => {
    it('parses a simple NAME=VALUE line', () => {
      const result = parseCredentialLine('ANTHROPIC_API_KEY=sk-ant-api03-xxx');
      expect(result).toEqual({
        name: 'ANTHROPIC_API_KEY',
        value: 'sk-ant-api03-xxx',
      });
    });

    it('splits on first equals only (value may contain =)', () => {
      const result = parseCredentialLine('KEY=value=with=equals');
      expect(result).toEqual({
        name: 'KEY',
        value: 'value=with=equals',
      });
    });

    it('handles empty value', () => {
      const result = parseCredentialLine('KEY=');
      expect(result).toEqual({ name: 'KEY', value: '' });
    });

    it('returns null for empty line', () => {
      expect(parseCredentialLine('')).toBeNull();
    });

    it('returns null for line without equals', () => {
      expect(parseCredentialLine('NOEQUALS')).toBeNull();
    });

    it('returns null for invalid name (starts with digit)', () => {
      expect(parseCredentialLine('1BAD=value')).toBeNull();
    });

    it('returns null for invalid name (contains spaces)', () => {
      expect(parseCredentialLine('BAD NAME=value')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // serializeCredentials
  // -----------------------------------------------------------------------

  describe('serializeCredentials', () => {
    it('serializes a single credential', () => {
      const creds: Credential[] = [{ name: 'API_KEY', value: 'secret123' }];
      const result = serializeCredentials(creds);
      expect(result).toBe('API_KEY=secret123\n\n');
    });

    it('serializes multiple credentials', () => {
      const creds: Credential[] = [
        { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-xxx' },
        { name: 'OTHER_SECRET', value: 'abc123' },
      ];
      const result = serializeCredentials(creds);
      expect(result).toBe('ANTHROPIC_API_KEY=sk-ant-xxx\nOTHER_SECRET=abc123\n\n');
    });

    it('serializes empty credential list', () => {
      const result = serializeCredentials([]);
      expect(result).toBe('\n');
    });

    it('handles values containing equals signs', () => {
      const creds: Credential[] = [{ name: 'TOKEN', value: 'base64==' }];
      const result = serializeCredentials(creds);
      expect(result).toBe('TOKEN=base64==\n\n');
    });

    it('throws on invalid credential name', () => {
      const creds: Credential[] = [{ name: '1BAD', value: 'v' }];
      expect(() => serializeCredentials(creds)).toThrow(/invalid credential name/i);
    });

    it('throws on credential name containing newline', () => {
      const creds: Credential[] = [{ name: 'KEY\nINJECT', value: 'v' }];
      expect(() => serializeCredentials(creds)).toThrow(/invalid credential name/i);
    });

    it('throws on credential value containing newline', () => {
      const creds: Credential[] = [{ name: 'KEY', value: 'line1\nline2' }];
      expect(() => serializeCredentials(creds)).toThrow(
        /credential value.*must not contain newline/i,
      );
    });

    it('round-trips through parse', () => {
      const creds: Credential[] = [
        { name: 'KEY_A', value: 'val_a' },
        { name: 'KEY_B', value: 'val_b=extra' },
      ];
      const serialized = serializeCredentials(creds);
      const lines = serialized.split('\n');

      // Last two elements are empty (trailing \n\n → ['', ''])
      const parsed = lines
        .filter((l) => l.length > 0)
        .map((l) => parseCredentialLine(l))
        .filter((c): c is Credential => c !== null);

      expect(parsed).toEqual(creds);
    });
  });
});
