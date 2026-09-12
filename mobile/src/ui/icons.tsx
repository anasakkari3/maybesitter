import React, { useId } from 'react';
import Svg, { Circle, Defs, Path, Pattern, Polyline, RadialGradient, Rect, Stop } from 'react-native-svg';

export function MicIcon({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round">
      <Rect x={9} y={3} width={6} height={11} rx={3} fill={color} />
      <Path d="M5 11a7 7 0 0 0 14 0" />
      <Path d="M12 18v3" />
    </Svg>
  );
}

export function CheckIcon({ size = 12, color = '#fff', weight = 2 }: { size?: number; color?: string; weight?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Polyline points="5,12.5 10,17.5 19,7" stroke={color} strokeWidth={weight * 2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function TodayIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8}>
      <Circle cx={12} cy={12} r={8.5} />
      <Circle cx={12} cy={12} r={2.2} fill={color} stroke="none" />
    </Svg>
  );
}

export function CalendarIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8}>
      <Rect x={3.5} y={3.5} width={7} height={7} rx={2} />
      <Rect x={13.5} y={3.5} width={7} height={7} rx={2} />
      <Rect x={3.5} y={13.5} width={7} height={7} rx={2} />
      <Rect x={13.5} y={13.5} width={7} height={7} rx={2} />
    </Svg>
  );
}

export function SettingsIcon({ color, knob }: { color: string; knob: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round">
      <Path d="M4 7h16M4 12h16M4 17h16" />
      <Circle cx={9} cy={7} r={2} fill={knob} />
      <Circle cx={15} cy={12} r={2} fill={knob} />
      <Circle cx={10} cy={17} r={2} fill={knob} />
    </Svg>
  );
}

/** Diagonal hatch for busy blocks: calendar busy time, never a title. */
export function Hatch({ color, radius = 12 }: { color: string; radius?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <Svg style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} width="100%" height="100%">
      <Defs>
        <Pattern id={id} patternUnits="userSpaceOnUse" width={9} height={9} patternTransform="rotate(45)">
          <Rect x={0} y={0} width={4} height={9} fill={color} />
        </Pattern>
      </Defs>
      <Rect x={0} y={0} width="100%" height="100%" rx={radius} fill={`url(#${id})`} />
    </Svg>
  );
}

/** Soft accent glow in the corner of the Today screen. */
export function Glow({ color, size = 320 }: { color: string; size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={color} stopOpacity={1} />
          <Stop offset="0.7" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
    </Svg>
  );
}

export function UndoRing({ left, track, color }: { left: number; track: string; color: string }) {
  const c = 69.1;
  return (
    <Svg width={26} height={26} viewBox="0 0 26 26" style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
      <Circle cx={13} cy={13} r={11} fill="none" stroke={track} strokeWidth={2.5} />
      <Circle cx={13} cy={13} r={11} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - left / 5)} />
    </Svg>
  );
}

/**
 * Google's "G" mark, for the sign-in button (UC-1.2 #146, guideline 4.8).
 *
 * The four paths and their colours are Google's standard published asset and
 * must not be recoloured, restyled or redrawn — the branding guidelines are
 * explicit about it, and a store reviewer checks. Before store submission,
 * diff this against the current file in Google's branding kit rather than
 * trusting it to have stayed correct.
 */
export function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <Path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <Path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <Path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </Svg>
  );
}
