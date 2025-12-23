# @nemu.pm/aidoku-cli

CLI for testing and exploring Aidoku sources.

**Requires [Bun](https://bun.sh)**

## Install

```bash
bun add -g @nemu.pm/aidoku-cli
```

## Usage

```bash
# List available sources
aidoku list

# Test source APIs
aidoku test <source-id> popular
aidoku test <source-id> search "one piece"

# Interactive exploration
aidoku explore

# Fetch from registry
aidoku registry list
```

## Configuration

Set `AIDOKU_SOURCES` environment variable to point to your sources directory, or create an `aidoku.config.json`:

```json
{
  "sources": "./sources"
}
```

## Documentation

See the main repository for full documentation: https://github.com/nemu-pm/aidoku-js

## License

MIT

