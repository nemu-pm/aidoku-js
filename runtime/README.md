# @nemu.pm/aidoku-runtime

Runtime for loading and executing Aidoku WASM sources in JavaScript environments.

## Install

```bash
bun add @nemu.pm/aidoku-runtime
# or
npm install @nemu.pm/aidoku-runtime
```

## Usage

```typescript
import { AidokuRuntime } from "@nemu.pm/aidoku-runtime";

const runtime = new AidokuRuntime();
const source = await runtime.loadSource(wasmBuffer, sourceInfo);

const mangas = await source.getMangaList([], 1);
```

## Documentation

See the main repository for full documentation: https://github.com/nemu-pm/aidoku-js

## License

MIT

