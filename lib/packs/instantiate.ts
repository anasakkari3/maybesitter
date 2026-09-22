/**
 * Instantiating a pack's watcher template (#528, slice 1).
 *
 * A `WatcherTemplate` is a `WatcherDefinition` with the user-owned blanks left
 * open; this fills them. The output is a `NewWatcherInput` for the existing
 * `WatcherStore` — the one place watchers are born — with `createdBy:
 * 'pack_template'`, which is how the monitoring surface and the audit trail
 * tell a pack-installed watcher from a hand-built one.
 *
 * The function refuses what the manifest forbids: a template whose effect the
 * pack did not declare in `allowedEffects` cannot instantiate, even
 * construction-side. The engine would deny an unknown effect at fire time;
 * this catches an undeclared-but-real one at install time, which is the
 * earlier of the two doors and the one a broken pack actually walks through.
 */

import type { ContextProviderKind } from '../../src/contracts/v1/integrationConnectionContracts';
import type { WatcherSourceRef } from '../../src/contracts/v1/watcherContracts';
import {
  validateVerticalPackDefinition,
  type VerticalPackDefinition,
  type WatcherTemplate,
} from '../../src/contracts/v1/verticalPackContracts';
import type { NewWatcherInput } from '../watchers/watcherStore';

export class PackInstantiationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackInstantiationError';
  }
}

export interface InstantiateWatcherTemplateArgs {
  readonly pack: VerticalPackDefinition;
  readonly templateId: string;
  readonly provider: ContextProviderKind;
  /** The user's grant. Required iff the template sets `requiresConnection`. */
  readonly connectionId: string | null;
  /** What the user pointed the watcher at. Opaque; never a payload. */
  readonly subjectRef: string;
}

export function instantiateWatcherTemplate(args: InstantiateWatcherTemplateArgs): NewWatcherInput {
  const { pack } = args;
  const template = pack.watcherTemplates.find((entry) => entry.templateId === args.templateId);
  if (!template) {
    throw new PackInstantiationError(`pack '${pack.packId}' has no watcher template '${args.templateId}'`);
  }
  if (validateVerticalPackDefinition(pack).length > 0) {
    throw new PackInstantiationError(`pack '${pack.packId}' is not a valid manifest`);
  }
  if (template.requiresConnection && args.connectionId === null) {
    throw new PackInstantiationError(`template '${template.templateId}' requires a connection`);
  }
  if (!template.requiresConnection && args.connectionId !== null) {
    throw new PackInstantiationError(`template '${template.templateId}' names no connection`);
  }

  const source: WatcherSourceRef = {
    provider: args.provider,
    connectionId: args.connectionId,
    signalKind: template.signalKind,
    subjectRef: args.subjectRef,
  };
  return {
    enabled: true,
    source,
    condition: template.condition,
    effect: template.effect,
    createdBy: 'pack_template',
  };
}
