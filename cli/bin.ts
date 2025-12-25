#!/usr/bin/env bun
// @nemu.pm/aidoku-cli - CLI for testing Aidoku sources
import { run } from "@stricli/core";
import { app } from "./app";

await run(app, process.argv.slice(2), {
  process,
});

// WASM memory / fetch connections keep event loop alive - force exit
process.exit(0);

