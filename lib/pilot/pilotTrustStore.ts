import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyPilotTrustAction,
  createPilotAuditEvent,
  createPilotTrustIncident,
  createPilotTrustState,
  requirePilotParticipantId,
  requirePilotTrustState,
  type PilotAuditEvent,
  type PilotTrustAction,
  type PilotTrustIncident,
  type PilotTrustState,
} from './closedPilotControls';

interface PilotTrustData {
  version: 'v1';
  participants: Record<string, PilotTrustState>;
  auditEvents: PilotAuditEvent[];
  incidents: PilotTrustIncident[];
}

function emptyData(): PilotTrustData {
  return { version: 'v1', participants: {}, auditEvents: [], incidents: [] };
}

function loadData(filePath: string): PilotTrustData {
  if (!existsSync(filePath)) return emptyData();
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PilotTrustData>;
  if (parsed.version !== 'v1' || !parsed.participants || !Array.isArray(parsed.auditEvents) || !Array.isArray(parsed.incidents)) {
    throw new Error('pilot trust store is corrupt or unsupported');
  }
  const participants: Record<string, PilotTrustState> = {};
  for (const [participantId, state] of Object.entries(parsed.participants)) {
    const validated = requirePilotTrustState(state);
    if (validated.participantId !== participantId) throw new Error('pilot trust participant key mismatch');
    participants[participantId] = validated;
  }
  return {
    version: 'v1',
    participants,
    auditEvents: parsed.auditEvents.map((event) => createPilotAuditEvent(event)),
    incidents: parsed.incidents.map((incident) => createPilotTrustIncident(incident)),
  };
}

export class PilotTrustStore {
  private data: PilotTrustData;

  constructor(private readonly filePath: string) {
    this.data = loadData(filePath);
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  getOrCreate(participantId: string, at: string): PilotTrustState {
    requirePilotParticipantId(participantId);
    const existing = Object.prototype.hasOwnProperty.call(this.data.participants, participantId)
      ? this.data.participants[participantId]
      : undefined;
    if (existing) return { ...existing };
    const created = createPilotTrustState(participantId, at);
    this.data.participants[participantId] = created;
    this.persist();
    return { ...created };
  }

  apply(participantId: string, action: PilotTrustAction): PilotTrustState {
    const current = this.getOrCreate(participantId, action.at);
    const updated = applyPilotTrustAction(current, action);
    this.data.participants[participantId] = updated;
    this.persist();
    return { ...updated };
  }

  appendAudit(event: PilotAuditEvent): PilotAuditEvent {
    const validated = createPilotAuditEvent(event);
    this.data.auditEvents.push(validated);
    this.persist();
    return { ...validated };
  }

  appendIncident(incident: PilotTrustIncident): PilotTrustIncident {
    const validated = createPilotTrustIncident(incident);
    if (this.data.incidents.some((item) => item.incidentId === validated.incidentId)) {
      throw new Error('incidentId already exists');
    }
    this.data.incidents.push(validated);
    this.persist();
    return { ...validated };
  }

  updateIncident(
    incidentId: string,
    updates: Pick<PilotTrustIncident, 'status' | 'containmentCode' | 'resolutionCode'>,
  ): PilotTrustIncident {
    const index = this.data.incidents.findIndex((incident) => incident.incidentId === incidentId);
    if (index < 0) throw new Error('incident not found');
    const updated = createPilotTrustIncident({ ...this.data.incidents[index], ...updates });
    this.data.incidents[index] = updated;
    this.persist();
    return { ...updated };
  }

  auditEvents(): PilotAuditEvent[] {
    return this.data.auditEvents.map((event) => ({ ...event }));
  }

  incidents(): PilotTrustIncident[] {
    return this.data.incidents.map((incident) => ({ ...incident }));
  }
}

let defaultStore: PilotTrustStore | null = null;
let defaultPath = '';

export function getPilotTrustStore(): PilotTrustStore {
  const filePath = process.env.MAYBESITTER_PILOT_TRUST_FILE || path.join(process.cwd(), '.maybesitter', 'pilot-trust.json');
  if (!defaultStore || defaultPath !== filePath) {
    defaultStore = new PilotTrustStore(filePath);
    defaultPath = filePath;
  }
  return defaultStore;
}
