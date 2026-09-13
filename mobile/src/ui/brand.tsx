import React from 'react';
import { Image, type ImageStyle, type StyleProp } from 'react-native';

const sources = {
  badge: require('../../assets/icon.png'),
  lockup: require('../../assets/brand-lockup.png'),
  mark: require('../../assets/brand-mark.png'),
} as const;

type BrandLogoProps = {
  decorative?: boolean;
  size?: number;
  style?: StyleProp<ImageStyle>;
  variant?: keyof typeof sources;
};

export function BrandLogo({ decorative = false, size = 40, style, variant = 'mark' }: BrandLogoProps) {
  return (
    <Image
      accessibilityLabel={decorative ? undefined : 'MaybeSitter'}
      accessibilityRole={decorative ? undefined : 'image'}
      accessible={!decorative}
      resizeMode="contain"
      source={sources[variant]}
      style={[
        { width: size, height: size },
        variant === 'badge' ? { borderRadius: size * 0.22 } : undefined,
        style,
      ]}
    />
  );
}
