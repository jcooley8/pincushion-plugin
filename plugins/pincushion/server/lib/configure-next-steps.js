// configure-next-steps.js — what the agent should do right after
// configure_project succeeds.
//
// Nov 22 2026: a new signup's agent registered a localhost project and then
// stopped. Nothing in the configure_project result asked it to read pins, and
// the embedded widget (the only way to drop a pin on localhost without the
// extension) was buried as an optional step. These next steps lead the result
// so the agent reads pins now and, on localhost, offers the widget first.

import { isLoopbackTarget } from './setup-core.js';
import { outdatedNotice } from './update-check.js';

export function hasLocalhostUrl(urls) {
  return Array.isArray(urls) && urls.some((url) => isLoopbackTarget(url));
}

export function configureNextSteps({ projectId, urls, widgetSnippet } = {}) {
  const steps = [
    `Next, right now: call get_actionable_pins${projectId ? ` with projectId "${projectId}"` : ''} and tell the owner what is there. That confirms this agent is connected and shows any pins already on the project.`,
  ];
  if (hasLocalhostUrl(urls) && widgetSnippet) {
    steps.push(
      'This project runs on localhost. The quickest way to drop a real pin there is the Pincushion widget: ask the owner if you can add this one line to the app\'s root layout or index.html, then have them reload the localhost page, click the pin button and drop one:\n' +
      `  ${widgetSnippet}\n` +
      'After they drop a pin, call get_actionable_pins again and work on it. Prefer the browser extension? It works on localhost too once it is signed in to the same account.',
    );
  }
  return steps;
}

// Adds `nextSteps` (and `updateAvailable` when this copy is outdated) to a
// successful configure_project result and puts them first in `instructions`.
// Failed or partial results are returned unchanged.
//
// The read-pins and widget steps only work for a project the Pincushion cloud
// has: the widget and get_actionable_pins both look the project up there. When
// cloud registration did not happen (not signed in, plan limit, auth or network
// error), cloudSync says why and those steps are left out, so the agent is not
// sent to edit source for a pin that cannot be saved. The update notice still
// leads, because updating is the same fix either way.
export function withConfigureNextSteps(result, { update } = {}) {
  if (!result || typeof result !== 'object' || !result.projectId || result.success === false || result.error) return result;
  const nextSteps = result.cloudSync === 'synced' ? configureNextSteps(result) : [];
  const notice = update?.outdated ? outdatedNotice(update) : '';
  if (!nextSteps.length && !notice) return result;
  const lead = [...(notice ? [notice] : []), ...nextSteps].join('\n\n');
  return {
    ...result,
    ...(nextSteps.length ? { nextSteps } : {}),
    ...(notice ? { updateAvailable: { current: update.current, latest: update.latest, message: notice } } : {}),
    instructions: leadInstructions(result.instructions, lead),
  };
}

// Keep the "Project … configured" confirmation as the first line, then the
// next steps, then everything else.
function leadInstructions(instructions, lead) {
  if (typeof instructions !== 'string' || !instructions) return lead;
  const split = instructions.indexOf('\n\n');
  if (!instructions.startsWith('Project ') || split === -1) return `${lead}\n\n${instructions}`;
  return `${instructions.slice(0, split)}\n\n${lead}${instructions.slice(split)}`;
}
