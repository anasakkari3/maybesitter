/**
 * Past «هيك فهمت» to the cards, for a screen test about the cards.
 *
 * The chat's answers carry `understood` now (M2a), so the app shows what it
 * understood first and the cards only after «هيك صح». A test about the cards
 * takes that step the way a person does; an answer without a summary (a
 * legacy proposal, a share's review) is left as it is.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

export async function openCards(): Promise<void> {
  await waitFor(() => {
    if (!screen.queryByTestId('understood-confirm') && !screen.queryByTestId('review-scroll')) throw new Error('no answer on screen yet');
  });
  const confirm = screen.queryByTestId('understood-confirm');
  if (confirm) await act(async () => { await fireEvent.press(confirm); });
}
