import {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
} from '@expo-google-fonts/outfit';
import {
  NotoNaskhArabic_400Regular,
  NotoNaskhArabic_500Medium,
  NotoNaskhArabic_600SemiBold,
  NotoNaskhArabic_700Bold,
} from '@expo-google-fonts/noto-naskh-arabic';

// Noto Naskh Arabic for Arabic, Outfit for Latin (design system, round 1).
export const fontMap = {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
  Outfit_700Bold,
  NotoNaskhArabic_400Regular,
  NotoNaskhArabic_500Medium,
  NotoNaskhArabic_600SemiBold,
  NotoNaskhArabic_700Bold,
};

export type Weight = 400 | 500 | 600 | 700;

const suffix: Record<Weight, string> = {
  400: '400Regular',
  500: '500Medium',
  600: '600SemiBold',
  700: '700Bold',
};

export function family(weight: Weight, arabic: boolean): string {
  return (arabic ? 'NotoNaskhArabic_' : 'Outfit_') + suffix[weight];
}
