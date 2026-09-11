import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, type StyleProp, type ViewStyle, View } from 'react-native';

const ease = Easing.bezier(0.2, 0.8, 0.2, 1);

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => sub.remove();
  }, []);
  return reduced;
}

function useLoop(duration: number, delay = 0, disabled = false) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (disabled) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, { toValue: 1, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [v, duration, delay, disabled]);
  return v;
}

/** Screen entrance: fade, rise 14pt, settle from 98.5% (ms-in). */
export function ScreenIn({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: reduced ? 0 : 340, easing: ease, useNativeDriver: true }).start();
  }, [v, reduced]);
  return (
    <Animated.View
      style={[
        { flex: 1, opacity: v, transform: [
          { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
          { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) },
        ] },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** Two expanding rings behind the mic (ms-ring). */
export function Rings({ color, size }: { color: string; size: number }) {
  const reduced = useReducedMotion();
  const a = useLoop(2400, 0, reduced);
  const b = useLoop(2400, 1200, reduced);
  const ring = (v: Animated.Value) => (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
      }}
    />
  );
  return (
    <>
      {ring(a)}
      {ring(b)}
    </>
  );
}

/** Slow breathing scale for the idle mic (ms-breathe). */
export function Breathe({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const v = useLoop(3000, 0, reduced);
  const scale = v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.05, 1] });
  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

function Bar({ color, duration, delay }: { color: string; duration: number; delay: number }) {
  const reduced = useReducedMotion();
  const v = useLoop(duration, delay, reduced);
  const scaleY = v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.3, 1, 0.3] });
  return <Animated.View style={{ width: 5, height: 56, borderRadius: 3, backgroundColor: color, transform: [{ scaleY }] }} />;
}

/** Listening waveform (ms-bar). */
export function Waveform({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 56 }}>
      {Array.from({ length: 14 }, (_, i) => (
        <Bar key={i} color={color} duration={900 + (i % 4) * 180} delay={i * 70} />
      ))}
    </View>
  );
}

function Dot({ color, delay }: { color: string; delay: number }) {
  const reduced = useReducedMotion();
  const v = useLoop(1400, delay, reduced);
  return (
    <Animated.View
      style={{
        width: 12, height: 12, borderRadius: 6, backgroundColor: color,
        opacity: v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.55, 1, 0.55] }),
        transform: [{ scale: v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.25, 1] }) }],
      }}
    />
  );
}

/** "Understanding…" dots (ms-pulse). */
export function ProcessingDots({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      {[0, 1, 2].map(i => <Dot key={i} color={color} delay={i * 200} />)}
    </View>
  );
}

/** Saved check pop (ms-pop). */
export function Pop({ children }: { children: React.ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 500, easing: ease, useNativeDriver: true }).start();
  }, [v]);
  const scale = v.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.6, 1.15, 1] });
  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

/** Loading skeleton pulse (ms-shimmer). */
export function Shimmer({ style }: { style: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const v = useLoop(1600, 0, reduced);
  return <Animated.View style={[style, { opacity: v.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.5, 1, 0.5] }) }]} />;
}

/** Bottom-sheet rise and scrim fade (ms-up / ms-fade). */
export function useSheetMotion() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 380, easing: ease, useNativeDriver: true }).start();
  }, [v]);
  return {
    scrim: { opacity: v.interpolate({ inputRange: [0, 0.65, 1], outputRange: [0, 1, 1] }) },
    panel: {
      opacity: v,
      transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [60, 0] }) }],
    },
  };
}
