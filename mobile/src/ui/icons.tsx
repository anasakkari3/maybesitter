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
