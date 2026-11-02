// Check before server.js dynamically loads its dependency graph.
import { exitIfUnsupportedNodeRuntime } from './node-runtime.js';

exitIfUnsupportedNodeRuntime(process.argv.slice(2));
