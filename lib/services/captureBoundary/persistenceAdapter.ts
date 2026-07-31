import { applyCommand, type Command, type DomainState } from '../../../src/domain/stateMachine';

export interface CapturePersistenceAdapter {
  persistAtomically(commands: readonly Command[]): Promise<{ state: DomainState }>;
  snapshot(): DomainState;
}

/**
 * Deterministic transactional adapter. Commands are applied to a private
 * candidate state first; canonical state changes only after every command
 * validates successfully.
 */
export class TransactionalCapturePersistenceAdapter implements CapturePersistenceAdapter {
  private state: DomainState;

  constructor(initialState: DomainState) {
    this.state = structuredClone(initialState);
  }

  async persistAtomically(commands: readonly Command[]): Promise<{ state: DomainState }> {
    let candidate = structuredClone(this.state);
    for (const command of commands) {
      const transition = applyCommand(candidate, command);
      candidate = transition.newState;
    }
    this.state = candidate;
    return { state: this.snapshot() };
  }

  snapshot(): DomainState {
    return structuredClone(this.state);
  }
}

