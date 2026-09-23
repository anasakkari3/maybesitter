import { apiRequest } from '../client';
import { z } from 'zod';
import {
  financialConnectionSchema,
  financialContextResponseSchema,
  financialManualResponseSchema,
  financialManualSavedSchema,
  type FinancialConnection,
  type FinancialContextResponse,
  type FinancialFieldId,
  type FinancialManualResponse,
  type FinancialManualSaved,
} from '../schemas/financial';

export function getFinancialContext(): Promise<FinancialContextResponse> {
  return apiRequest('GET', '/api/mobile/financial/context', { schema: financialContextResponseSchema });
}

export function getFinancialManual(): Promise<FinancialManualResponse> {
  return apiRequest('GET', '/api/mobile/financial/manual', { schema: financialManualResponseSchema });
}

export function putFinancialField(input: {
  field: FinancialFieldId;
  kind: 'statement' | 'correction';
  value: number | string;
}): Promise<FinancialManualSaved> {
  return apiRequest('PUT', '/api/mobile/financial/manual', { body: input, schema: financialManualSavedSchema });
}

export function putFinancialObligation(input: {
  label: string;
  category: 'rent' | 'card' | 'loan' | 'subscription' | 'utility' | 'tuition' | 'other';
  dueAt: string;
  amountMinorUnits: number;
  currency: string;
  recurring?: boolean;
}): Promise<FinancialManualSaved> {
  return apiRequest('PUT', '/api/mobile/financial/manual', { body: input, schema: financialManualSavedSchema });
}

const removedSchema = z.object({ success: z.literal(true) });

/** The undo: the field goes back to whatever the connected source says. */
export function deleteFinancialField(field: FinancialFieldId): Promise<{ success: true }> {
  return apiRequest('DELETE', '/api/mobile/financial/manual', { query: { field }, schema: removedSchema });
}

export function deleteFinancialObligation(obligationId: string): Promise<{ success: true }> {
  return apiRequest('DELETE', '/api/mobile/financial/manual', { query: { obligationId }, schema: removedSchema });
}

export function getFinancialConnection(): Promise<FinancialConnection> {
  return apiRequest('GET', '/api/mobile/financial/connection', { schema: financialConnectionSchema });
}

export function connectFinancialSource(): Promise<FinancialConnection> {
  return apiRequest('POST', '/api/mobile/financial/connection', {
    schema: financialConnectionSchema,
    expectStatus: 201,
  });
}

export function disconnectFinancialSource(): Promise<{ success: true }> {
  return apiRequest('DELETE', '/api/mobile/financial/connection', { schema: removedSchema });
}
