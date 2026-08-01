const STORAGE_KEY = 'maybesitter:v03-pilot-id';
const PILOT_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export function pilotIdentity(): string {
  const invitationId = new URL(window.location.href).searchParams.get('pilotId');
  if (invitationId && PILOT_ID.test(invitationId)) {
    window.localStorage.setItem(STORAGE_KEY, invitationId);
    return invitationId;
  }
  return window.localStorage.getItem(STORAGE_KEY) || '';
}

export function clearPilotIdentity(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
