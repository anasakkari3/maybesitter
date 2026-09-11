export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateRuntimeConfiguration } = await import('../lib/runtime/runtimeConfig');
    validateRuntimeConfiguration();
  }
}
