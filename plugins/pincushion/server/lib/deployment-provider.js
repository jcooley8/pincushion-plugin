// Compatibility facade for the historic Vercel helpers, plus the neutral
// registry surface. Provider adapters remain opt-in injections: importing this
// facade never selects Vercel (or any provider) for a caller.

export {
  createVercelCliRunner,
  runVercelCli,
  createVercelDeploymentAdapter,
  ensureVercelDeploymentWebhook,
} from './deployment-providers/vercel.js';

export {
  detectDeploymentProviders,
  inspectDeploymentProvider,
  ensureDeploymentProvider,
  compensateDeploymentProviderAttempt,
  buildManualDeploymentHandoff,
} from './deployment-providers/registry.js';
