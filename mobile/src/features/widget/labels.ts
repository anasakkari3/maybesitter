import type { Strings } from '../../i18n/strings';
import type { WidgetLabels } from './snapshot';

/** The widget's words, in the language the app is in. */
export function widgetLabelsFor(t: Strings): WidgetLabels {
  return {
    privateCommitment: t.widgetPrivateCommitment,
    nextStep: t.widgetNextStep,
    empty: t.widgetEmpty,
    capture: t.widgetCapture,
    stale: t.widgetStale,
  };
}
