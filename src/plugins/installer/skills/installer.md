# Installer

Manage Carapace plugins: install from git repositories, verify setup, list,
update, remove, and configure plugins.

## Security

- **Never ask the user to paste credentials, API keys, tokens, or secrets into this conversation.**
- **Always direct users to create credential files manually at the specified paths.**
- **Never echo, display, or include credential values in any response.**

When a plugin requires credentials, tell the user the file path and let them
create the file themselves using their terminal or editor. Do not offer to write
credential files on their behalf.

---

## plugin_install

Install a plugin from a git repository URL. The repository is cloned, sanitized,
and its manifest is validated before the plugin becomes available.

### Usage

```bash
ipc tool.invoke.plugin_install '{"url": "https://github.com/user/carapace-weather.git"}'
```

### Arguments

| Argument | Type   | Required | Description                                           |
| -------- | ------ | -------- | ----------------------------------------------------- |
| `url`    | string | Yes      | Git repository URL (https:// or git@)                 |
| `name`   | string | No       | Override the default plugin name derived from the URL |

### Examples

Install a plugin:

```bash
ipc tool.invoke.plugin_install '{"url": "https://github.com/user/carapace-weather.git"}'
```

Install with a custom name:

```bash
ipc tool.invoke.plugin_install '{"url": "https://github.com/user/carapace-weather.git", "name": "weather"}'
```

### Return Format

On success, the result includes:

- `plugin_name` — The installed plugin name
- `version` — Plugin version from manifest
- `description` — Plugin description
- `tools` — List of tool names provided by the plugin
- `credentials_needed` — Array of credential requirements, each with:
  - `key` — Credential key name
  - `description` — What this credential is for
  - `required` — Whether the credential is required
  - `file` — Full path where the credential file should be created
  - `obtain_url` — URL where the user can get this credential (if provided)
  - `format_hint` — Expected format of the credential value (if provided)

### Credential Setup Workflow

When `credentials_needed` is non-empty, guide the user through setup:

1. Show them each required credential with its description.
2. If `obtain_url` is provided, tell them where to get the credential.
3. Tell them to create the credential file at the specified `file` path.
4. Remind them to set restrictive permissions: `chmod 600 <file>`.
5. After they confirm setup, use `plugin_verify` to check everything is correct.

### Notes

- Risk level: `high` (requires user confirmation).
- The plugin name is derived from the last segment of the git URL unless overridden.
- Reserved names (built-in plugins) cannot be used.
- If cloning or validation fails, any partially cloned files are cleaned up automatically.

---

## plugin_verify

Verify that a plugin's credentials and configuration are properly set up.

### Usage

```bash
ipc tool.invoke.plugin_verify '{"name": "weather"}'
```

### Arguments

| Argument | Type   | Required | Description                         |
| -------- | ------ | -------- | ----------------------------------- |
| `name`   | string | Yes      | The installed plugin name to verify |

### Examples

```bash
ipc tool.invoke.plugin_verify '{"name": "weather"}'
```

### Notes

- Risk level: `low` (auto-executed, no confirmation needed).
- Use this after installation to confirm credential files exist and are readable.
- Reports which credentials are present, missing, or have permission issues.

---

## plugin_list

List all installed and built-in plugins.

### Usage

```bash
ipc tool.invoke.plugin_list '{}'
```

### Arguments

| Argument          | Type    | Required | Description                                          |
| ----------------- | ------- | -------- | ---------------------------------------------------- |
| `include_builtin` | boolean | No       | Include built-in plugins in the list (default: true) |

### Examples

List all plugins:

```bash
ipc tool.invoke.plugin_list '{}'
```

List only user-installed plugins:

```bash
ipc tool.invoke.plugin_list '{"include_builtin": false}'
```

### Notes

- Risk level: `low` (auto-executed, no confirmation needed).
- Returns plugin name, version, description, tool count, and whether it is built-in.

---

## plugin_remove

Remove an installed plugin.

### Usage

```bash
ipc tool.invoke.plugin_remove '{"name": "weather"}'
```

### Arguments

| Argument             | Type    | Required | Description                                          |
| -------------------- | ------- | -------- | ---------------------------------------------------- |
| `name`               | string  | Yes      | The plugin name to remove                            |
| `remove_credentials` | boolean | No       | Also remove stored credential files (default: false) |

### Examples

Remove plugin, keep credentials:

```bash
ipc tool.invoke.plugin_remove '{"name": "weather"}'
```

Remove plugin and its credentials:

```bash
ipc tool.invoke.plugin_remove '{"name": "weather", "remove_credentials": true}'
```

### Notes

- Risk level: `high` (requires user confirmation).
- Built-in plugins cannot be removed.
- By default, credential files are preserved so re-installing does not require re-entering them.

---

## plugin_update

Update a git-installed plugin to the latest version.

### Usage

```bash
ipc tool.invoke.plugin_update '{"name": "weather"}'
```

### Arguments

| Argument | Type   | Required | Description               |
| -------- | ------ | -------- | ------------------------- |
| `name`   | string | Yes      | The plugin name to update |

### Examples

```bash
ipc tool.invoke.plugin_update '{"name": "weather"}'
```

### Notes

- Risk level: `high` (requires user confirmation).
- Pulls the latest changes from the plugin's git remote.
- Re-validates the manifest after updating.
- Built-in plugins cannot be updated this way.

---

## plugin_configure

Set a non-secret configuration value for a plugin. Use this for settings that
are not sensitive (not credentials, tokens, or keys).

### Usage

```bash
ipc tool.invoke.plugin_configure '{"name": "weather", "key": "default_unit", "value": "celsius"}'
```

### Arguments

| Argument | Type   | Required | Description                  |
| -------- | ------ | -------- | ---------------------------- |
| `name`   | string | Yes      | The plugin name to configure |
| `key`    | string | Yes      | The configuration key to set |
| `value`  | string | Yes      | The configuration value      |

### Examples

```bash
ipc tool.invoke.plugin_configure '{"name": "weather", "key": "default_unit", "value": "celsius"}'
```

```bash
ipc tool.invoke.plugin_configure '{"name": "notifications", "key": "quiet_hours", "value": "22:00-07:00"}'
```

### Notes

- Risk level: `low` (auto-executed, no confirmation needed).
- Only for non-secret values. For credentials and secrets, always direct the user
  to create credential files manually at the paths reported by `plugin_install`
  or `plugin_verify`.
- Configuration values are validated against the plugin's `config_schema` if one
  is declared in the manifest.

---

## Typical Workflow

1. **Install**: `plugin_install` with the git URL.
2. **Set up credentials**: Read the `credentials_needed` from the install response.
   Direct the user to create each credential file at the specified path.
3. **Verify**: `plugin_verify` to confirm credentials are in place.
4. **Configure**: `plugin_configure` for any non-secret settings.
5. **Use**: The plugin's tools are now available in the session.

For ongoing maintenance:

- `plugin_list` to see what is installed.
- `plugin_update` to pull the latest version.
- `plugin_remove` to uninstall when no longer needed.
