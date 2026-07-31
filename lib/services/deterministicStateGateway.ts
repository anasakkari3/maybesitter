import { applyCommand, getCommandServiceState, type CommandServiceResult } from './commandService';
import type { Command, DomainState } from '../../src/domain/stateMachine';
export type { CommandServiceResult } from './commandService';

export interface DeterministicStateGateway {
  apply(command: Command): CommandServiceResult;
  snapshot(): DomainState;
}

class CommandServiceGateway implements DeterministicStateGateway {
  apply(command: Command): CommandServiceResult {
    return applyCommand(command);
  }

  snapshot(): DomainState {
    return getCommandServiceState();
  }
}

const defaultGateway: DeterministicStateGateway = new CommandServiceGateway();

export function getDeterministicStateGateway(): DeterministicStateGateway {
  return defaultGateway;
}

