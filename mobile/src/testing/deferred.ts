/**
 * A promise the test settles by hand.
 *
 * ── Why a test would want one ────────────────────────────────────
 *
 * Some of what a screen does is only true for a moment: "the request has been
 * sent and has not come back", "the move is on screen and the refusal has not
 * arrived". A mock that resolves on its own turns those into a window, and an
 * assertion on a window is a race with whatever machine the suite is running
 * on. It passes on a quiet laptop and fails on a loaded CI runner — or, worse,
 * the other way round, which is a guard that cannot fail for the work it
 * covers.
 *
 * `waitFor` does not fix it. `waitFor` retries until something becomes true,
 * so it is the right tool for a settled consequence and the wrong one for a
 * state that is about to stop being true: on a slow machine it will happily
 * wait past the thing it was meant to catch. Raising its timeout, or sleeping,
 * swaps one wall-clock dependency for another — the class of rot this
 * repository has already paid for twice (#380, #382).
 *
 * So the state is *held open* instead of caught in flight. Nothing resolves
 * until the test says so, the assertion happens while the promise is still
 * pending, and there is no window to miss because the window does not close.
 *
 *   const answer = deferred<PlanSettings>();
 *   jest.spyOn(endpoints, 'getPlanSettings').mockReturnValue(answer.promise);
 *   await show();
 *   expect(toggle.props.disabled).toBe(true);   // cannot be otherwise
 *   await act(async () => { answer.resolve(OFF); });
 *
 * A rejection is the same shape, and is how a refusal is delivered at the
 * exact point a test wants it rather than whenever a mock got round to it.
 */
export interface Deferred<T> {
  /** Handed to the code under test. Pending until `resolve` or `reject`. */
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  // The promise is returned to the caller, which attaches its own handlers;
  // this one only stops Node reporting an unhandled rejection in the gap
  // between `reject` and the code under test getting to its `catch`.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
