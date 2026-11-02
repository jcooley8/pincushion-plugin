// A transport-neutral registry for MCP and local REST tool dispatch.
// Both transports use one immutable table instead of maintaining parallel
// switch statements as the tool surface grows.

export function createToolRegistry(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new TypeError('tool registry entries must be an object');
  }
  const registry = Object.create(null);
  for (const [name, handler] of Object.entries(entries)) {
    if (!name || typeof handler !== 'function') {
      throw new TypeError(`tool registry entry ${name || '(unnamed)'} must be callable`);
    }
    registry[name] = handler;
  }
  return Object.freeze(registry);
}

export async function dispatchRegisteredTool(registry, toolName, toolArgs = {}) {
  const handler = registry?.[toolName];
  if (typeof handler !== 'function') return { error: `Unknown tool: ${toolName}` };
  return await handler(toolArgs);
}
