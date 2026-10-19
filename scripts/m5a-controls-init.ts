import { callM5aControl } from './m5a-control-client';

void callM5aControl({ action: 'init' }).catch((error) => { console.error(error); process.exitCode = 1; });
