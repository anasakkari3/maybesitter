import React from 'react';
import { Animated, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../state/AppContext';
import { Pill, Txt } from '../../ui/primitives';
import { useSheetMotion } from '../../ui/motion';
import { NumberedSteps } from '../../ui/steps';

/**
 * How to send something in through the Share Sheet — three short steps.
 *
 * WhatsApp chats, PDFs/files and photos are not connections: they arrive when
 * the person shares them from the other app (`ShareProvider`,
 * `/api/mobile/capture/share`). There is nothing in this app to open for them,
 * so their rows open this instead of a screen that is about something else.
 * It is only reachable when share intake is switched on in the build; with it
 * off those rows are Coming soon and have no action at all.
 */
export type ShareGuideKind = 'whatsapp' | 'files';

const STEPS = {
  whatsapp: { title: 'xWhatsappGuideTitle', steps: ['xWhatsappStep1', 'xWhatsappStep2', 'xShareStepPick'], or: 'xWhatsappGuideOr' },
  files: { title: 'xFilesGuideTitle', steps: ['xFilesStep1', 'xFilesStep2', 'xShareStepPick'], or: null },
} as const;

export function ShareGuideSheet({ kind, onClose }: { kind: ShareGuideKind; onClose: () => void }) {
  const { t, p } = useApp();
  const m = useSheetMotion();
  const insets = useSafeAreaInsets();
  const guide = STEPS[kind];
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40, justifyContent: 'flex-end' }}>
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: p.scrim }, m.scrim]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel={t.close} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        testID={`share-guide-${kind}`}
        style={[{ maxHeight: '85%', backgroundColor: p.sf, borderTopStartRadius: 28, borderTopEndRadius: 28 }, m.panel]}
      >
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 16 }}>
          <Txt role="section">{t[guide.title]}</Txt>
          <NumberedSteps steps={guide.steps.map(key => t[key])} />
          {guide.or ? <Txt role="supporting" color={p.mu}>{t[guide.or]}</Txt> : null}
          <Pill testID="share-guide-close" label={t.ok} onPress={onClose} />
        </ScrollView>
      </Animated.View>
    </View>
  );
}
