#!/usr/bin/env node
// cli.js — `npx pincushion-mcp` entry point.
//
// Checks the Node.js version before loading server.js, whose static imports
// may fail to link on an unsupported runtime. Keep this file and
// lib/node-runtime.js dependency-free and parseable on old Node releases.

import { exitIfUnsupportedNodeRuntime } from './lib/node-runtime.js';

exitIfUnsupportedNodeRuntime(process.argv.slice(2));
import('./server.js');
