import { callM5aControl, requestedCapability } from './m5a-control-client';

const expectedEpoch = Number(process.argv[3]);
if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) throw new Error('expected epoch must be a non-negative safe integer');
void callM5aControl({ action: 'enable', capability: requestedCapability(process.argv[2]), expectedEpoch })
  .catch((error) => { console.error(error); process.exitCode = 1; });
