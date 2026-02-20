# Echo

A minimal echo tool for testing the Carapace IPC pipeline. Sends text to the
host and receives it back unchanged.

## echo

Echoes input text back to the caller. Use this tool to verify that the IPC
connection between the container and host is working correctly.

### Usage

```bash
ipc tool.invoke.echo '{"text": "hello world"}'
```

### Arguments

| Argument | Type   | Required | Description            |
| -------- | ------ | -------- | ---------------------- |
| `text`   | string | Yes      | The text to echo back. |

### Examples

Simple echo:

```bash
ipc tool.invoke.echo '{"text": "ping"}'
```

Returns:

```json
{ "ok": true, "result": { "echoed": "ping" } }
```

### Notes

- This tool always succeeds. If `text` is omitted, an empty string is returned.
- Risk level: `low` (auto-executed, no confirmation needed).
