import {
  applyCommand as applyDomainCommand,
  type Command,
  type DomainState,
} from '../../../src/domain/stateMachine';
import type { CapturePersistenceAdapter } from '../captureBoundary';
import {
  configureCommandService,
  getCommandServiceState,
} from '../commandService';

export class CommandServiceCapturePersistenceAdapter implements CapturePersistenceAdapter {
  async persistAtomically(commands: readonly Command[]): Promise<{ state: DomainState }> {
    configureCommandService({});
    let candidate = structuredClone(getCommandServiceState());
    for (const command of commands) {
      const transition = applyDomainCommand(candidate, command);
      candidate = transition.newState;
    }
    configureCommandService({ initialState: candidate });
    return { state: this.snapshot() };
  }

  snapshot(): DomainState {
    configureCommandService({});
    return structuredClone(getCommandServiceState());
  }
}
