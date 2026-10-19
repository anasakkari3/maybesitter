import { callM5aControl, requestedCapability } from './m5a-control-client';

void callM5aControl({ action: 'kill', capability: requestedCapability(process.argv[2]) })
  .catch((error) => { console.error(error); process.exitCode = 1; });
