/**
 * Minimal YAML parser for docker-compose.yml validation tests.
 *
 * Handles the subset of YAML used in compose files: maps, sequences,
 * scalars (strings, numbers, booleans), and comments. Does not handle
 * anchors, aliases, multi-line strings, or complex YAML features.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap;
type YamlMap = { [key: string]: YamlValue };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parse(input: string): Record<string, unknown> {
  const lines = input.split('\n');
  const result = parseBlock(lines, 0, 0);
  return result.value as Record<string, unknown>;
}

interface ParseResult {
  value: YamlValue;
  nextLine: number;
}

function parseBlock(lines: string[], startLine: number, indent: number): ParseResult {
  const map: YamlMap = {};
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.replace(/#.*$/, '').trimEnd();

    // Skip empty lines and comments
    if (stripped.trim().length === 0) {
      i++;
      continue;
    }

    const lineIndent = line.search(/\S/);
    if (lineIndent < indent) {
      break; // dedent — return to parent
    }

    if (lineIndent > indent && startLine > 0) {
      break; // over-indented for this block level
    }

    // Key: value or Key:
    const match = stripped.match(/^(\s*)([^:\s][^:]*?):\s*(.*)/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[2].trim();
    const inlineValue = match[3].trim();

    if (inlineValue.length > 0) {
      // Check for inline sequence: [a, b, c]
      if (inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
        const inner = inlineValue.slice(1, -1);
        const items = inner.split(',').map((s) => parseScalar(s.trim()));
        map[key] = items;
        i++;
      } else {
        map[key] = parseScalar(inlineValue);
        i++;
      }
    } else {
      // Check if next line is a sequence (starts with -)
      const nextNonEmpty = findNextNonEmpty(lines, i + 1);
      if (nextNonEmpty < lines.length) {
        const nextLine = lines[nextNonEmpty];
        const nextIndent = nextLine.search(/\S/);
        const nextTrimmed = nextLine.trim();

        if (nextTrimmed.startsWith('- ') || nextTrimmed === '-') {
          // Sequence
          const seqResult = parseSequence(lines, nextNonEmpty, nextIndent);
          map[key] = seqResult.value;
          i = seqResult.nextLine;
        } else if (nextIndent > lineIndent) {
          // Nested map
          const subResult = parseBlock(lines, nextNonEmpty, nextIndent);
          map[key] = subResult.value;
          i = subResult.nextLine;
        } else {
          map[key] = null;
          i++;
        }
      } else {
        map[key] = null;
        i++;
      }
    }
  }

  return { value: map, nextLine: i };
}

function parseSequence(lines: string[], startLine: number, indent: number): ParseResult {
  const arr: YamlValue[] = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.replace(/#.*$/, '').trimEnd();

    if (stripped.trim().length === 0) {
      i++;
      continue;
    }

    const lineIndent = line.search(/\S/);
    if (lineIndent < indent) {
      break;
    }

    const trimmed = stripped.trim();
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();
      // Check if the item itself starts a map (has a colon)
      if (value.includes(':') && !value.startsWith('"') && !value.startsWith("'")) {
        // It's a map entry in a sequence — just take as scalar for simplicity
        arr.push(parseScalar(value));
      } else {
        arr.push(parseScalar(value));
      }
      i++;
    } else if (trimmed === '-') {
      arr.push(null);
      i++;
    } else {
      break;
    }
  }

  return { value: arr, nextLine: i };
}

function parseScalar(s: string): string | number | boolean | null {
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;

  // Quoted strings
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }

  // Numbers
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);

  return s;
}

function findNextNonEmpty(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    const stripped = lines[i].replace(/#.*$/, '').trim();
    if (stripped.length > 0) return i;
  }
  return lines.length;
}
