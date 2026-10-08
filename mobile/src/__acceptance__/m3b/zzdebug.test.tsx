import { afterEach, beforeEach, it } from '@jest/globals';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { ACCOUNT_B, defaultReply, emitAccount, openGenericCapture, prepareM3b, teardown, withKinds, type M3bHarness } from './harness';
let harness: M3bHarness;
beforeEach(async () => { harness = await prepareM3b(); });
afterEach(async () => { await teardown(harness); });
it('debug generic', async () => {
  harness.server.handler = withKinds(['goal', 'habit', 'thought'], defaultReply);
  await openGenericCapture(harness);
  emitAccount(harness, ACCOUNT_B);
  await act(async () => { await fireEvent.changeText(screen.getByTestId('capture-input'), 'hello'); });
  console.log('generic after switch value:', JSON.stringify(screen.queryByTestId('capture-input')?.props.value));
});
