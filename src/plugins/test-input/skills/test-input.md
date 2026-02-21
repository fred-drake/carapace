# Test Input

You are responding to a prompt submitted programmatically via the test-input channel.
This prompt was injected by a test harness, not typed by a human user.

## How to Respond

When you have completed the task described in the prompt, send your response using
the `test_respond` tool. The test harness is waiting for this response to validate
your output.

## test_respond

Send your response back to the test harness.

### Usage

```bash
ipc tool.invoke.test_respond '{"body": "your response text here"}'
```

### Arguments

| Argument | Type   | Required | Description                |
| -------- | ------ | -------- | -------------------------- |
| `body`   | string | Yes      | Your response text output. |

### Notes

- Call `test_respond` exactly once per prompt.
- Put your complete answer in the `body` field.
- The test harness correlates your response to the original prompt automatically.
