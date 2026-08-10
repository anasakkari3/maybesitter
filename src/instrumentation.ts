export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validatePilotRuntimeConfiguration } = await import('../lib/services/mobile/pilotRuntimeConfig');
    validatePilotRuntimeConfiguration();
  }
}
