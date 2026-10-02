import React, { useId } from 'react';
import { Platform } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { useApp } from '../state/AppContext';

export type IconName =
  | 'search' | 'bell' | 'calendar' | 'pin' | 'note' | 'play' | 'clock'
  | 'bulb' | 'chevron-down' | 'chevron-right' | 'cart' | 'phone' | 'mic'
  | 'grid' | 'sliders' | 'target' | 'video' | 'laptop' | 'plus' | 'sparkles'
  | 'bolt' | 'check' | 'close' | 'logo'
  // The Stitch bar and hubs (2026-10-02).
  | 'today' | 'shapes' | 'radar' | 'flag' | 'repeat' | 'clipboard' | 'eye' | 'person'
  // Today, the details screen and the banners (Stitch lane A).
  | 'football' | 'cloud-off' | 'refresh' | 'alert' | 'archive' | 'trash' | 'pencil' | 'chevron-up';

export interface IconProps {
  name: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/** The reference's vector artwork, rendered with native SVG primitives. */
export function ReferenceIcon({ name, size = 24, color: requestedColor, strokeWidth = 1.8 }: IconProps) {
  const { p } = useApp();
  const color = requestedColor ?? p.tx;
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const solid = { fill: color, stroke: 'none' };
  let content: React.ReactNode;
  switch (name) {
    case 'football':
      // A ball: a pentagon at the centre and the seams out to the rim.
      content = <><Circle cx={12} cy={12} r={9.5} /><Path d="m12 8.2 3.6 2.6-1.4 4.2H9.8l-1.4-4.2Z" /><Path d="M12 8.2V2.6M15.6 10.8l5.3-1.8M14.2 15l3.3 4.6M9.8 15l-3.3 4.6M8.4 10.8 3.1 9" /></>;
      break;
    case 'cloud-off':
      content = <><Path d="M7.5 19h9.7a3.8 3.8 0 0 0 1.4-7.3A6 6 0 0 0 8.2 8.4M5.6 10.6A4.3 4.3 0 0 0 7.5 19" /><Path d="m3 3 18 18" /></>;
      break;
    case 'refresh':
      content = <Path d="M20 11.5A8 8 0 1 0 17.7 17M20 4.5v7h-7" />;
      break;
    case 'alert':
      content = <><Path d="M10.3 3.9 2.5 17.6A2 2 0 0 0 4.2 20.6h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><Path d="M12 9.5v4.2" /><Circle {...solid} cx={12} cy={17} r={1.1} /></>;
      break;
    case 'archive':
      content = <><Rect x={3} y={4} width={18} height={5} rx={1.2} /><Path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></>;
      break;
    case 'trash':
      content = <Path d="M4 6.5h16M9.5 6.5V4.2h5v2.3M6.2 6.5l.9 12.6A1.5 1.5 0 0 0 8.6 20.5h6.8a1.5 1.5 0 0 0 1.5-1.4l.9-12.6M10 10.5v6M14 10.5v6" />;
      break;
    case 'pencil':
      content = <Path d="M4 20h4L19.3 8.7a2.1 2.1 0 0 0 0-3L18.3 4.7a2.1 2.1 0 0 0-3 0L4 16Z M13.5 6.5l4 4" />;
      break;
    case 'chevron-up':
      content = <Path d="m6 15 6-6 6 6" />;
      break;
    case 'person':
      content = <><Circle cx={12} cy={7.5} r={3.5} /><Path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2" /></>;
      break;
    case 'today':
      content = <><Rect x={4} y={5} width={16} height={16} rx={2} /><Path d="M8 2.5v5M16 2.5v5M4 10h16" /><Circle {...solid} cx={12} cy={15.5} r={2} /></>;
      break;
    case 'shapes':
      content = <><Path d="M12 3 16.5 10.5h-9Z" /><Circle cx={7.5} cy={17} r={3.5} /><Rect x={13.5} y={13.5} width={7} height={7} rx={1.2} /></>;
      break;
    case 'radar':
      content = <><Circle cx={12} cy={12} r={9} /><Circle cx={12} cy={12} r={5} /><Circle {...solid} cx={12} cy={12} r={1.6} /><Path d="M12 12 18.4 5.6" /></>;
      break;
    case 'flag':
      content = <Path d="M5 21V4M5 4h11l-2 4 2 4H5" />;
      break;
    case 'repeat':
      content = <Path d="M17 2.5 20.5 6 17 9.5M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5M7 21.5 3.5 18 7 14.5M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5" />;
      break;
    case 'clipboard':
      content = <><Rect x={5} y={4} width={14} height={17} rx={2} /><Rect x={9} y={2.5} width={6} height={3.5} rx={1} /><Path d="M8.5 11h7M8.5 15h5" /></>;
      break;
    case 'eye':
      content = <><Path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><Circle cx={12} cy={12} r={3} /></>;
      break;
    case 'search':
      content = <><Circle cx={10.4} cy={10.4} r={7.3} /><Path d="m15.8 15.8 5 5" /></>;
      break;
    case 'bell':
      content = <Path d="M5.2 17.4h13.6c-1.7-1.9-1.7-3.7-1.7-7A5.1 5.1 0 0 0 12 5.2a5.1 5.1 0 0 0-5.1 5.2c0 3.3 0 5.1-1.7 7ZM12 3.1v2.1M9.5 20.1h5" />;
      break;
    case 'calendar':
      content = <><Rect x={4} y={5} width={16} height={16} rx={1.5} /><Path d="M8 2.5v5M16 2.5v5M4 10h16M8 14h2M14 14h2M8 17.5h2" /></>;
      break;
    case 'pin':
      content = <><Path d="M18.7 9.2C18.7 14.2 12 21 12 21S5.3 14.2 5.3 9.2a6.7 6.7 0 1 1 13.4 0Z" /><Circle cx={12} cy={9.1} r={2.5} /></>;
      break;
    case 'note':
      content = <><Rect x={5} y={3} width={14} height={18} rx={1} /><Path d="M8.5 7h7M8.5 11h7M8.5 15h7" /></>;
      break;
    case 'play':
      content = <Path {...solid} d="M6.6 3.2a.9.9 0 0 0-1.4.8v16a.9.9 0 0 0 1.4.8l12.5-8a.95.95 0 0 0 0-1.6Z" />;
      break;
    case 'clock':
      content = <><Circle cx={12} cy={12} r={9} /><Path d="M12 5.8V12l4.1 2.9" /></>;
      break;
    case 'bulb':
      content = <Path d="M8.8 16.9c-.2-3-3-3.9-3-7.2a6.2 6.2 0 1 1 12.4 0c0 3.3-2.8 4.2-3 7.2ZM9 19.5h6M10.2 22h3.6" />;
      break;
    case 'chevron-down':
      content = <Path d="m5 8.5 7 7 7-7" />;
      break;
    case 'chevron-right':
      content = <Path d="m8.5 4.5 7.5 7.5-7.5 7.5" />;
      break;
    case 'cart':
      content = <><Path d="M2.5 4h2.8l2.2 11.6h11.2M6 7h15l-2 6H7.1" /><Circle cx={9} cy={19.5} r={1} /><Circle cx={18} cy={19.5} r={1} /></>;
      break;
    case 'phone':
      content = <Path {...solid} d="m7.1 2.9 2.5 4.7c.3.5.2 1-.2 1.4l-1.8 1.7c1.3 2.7 3.2 4.6 5.9 5.9l1.7-1.8c.4-.4.9-.5 1.4-.2l4.7 2.5c.5.3.7.8.5 1.4l-.7 2c-.3.9-1.2 1.5-2.2 1.4C10.1 20.9 3.1 13.9 2.1 5.1c-.1-1 .5-1.9 1.4-2.2l2-.7c.6-.2 1.1 0 1.4.5Z" />;
      break;
    case 'mic':
      content = <><Rect {...solid} x={8} y={2} width={8} height={13} rx={4} /><Path d="M4.7 11.3V12a7.3 7.3 0 0 0 14.6 0v-.7M12 19.3V23" strokeWidth={2} /></>;
      break;
    case 'grid':
      content = <><Rect x={3} y={3} width={7} height={8} rx={1.8} /><Rect x={14} y={3} width={7} height={8} rx={1.8} /><Rect x={3} y={15} width={7} height={6} rx={1.8} /><Rect x={14} y={15} width={7} height={6} rx={1.8} /></>;
      break;
    case 'sliders':
      content = <><Path d="M2 5h8M14 5h8M2 12h3M9 12h13M2 19h11M17 19h5" /><Circle cx={12} cy={5} r={2} /><Circle cx={7} cy={12} r={2} /><Circle cx={15} cy={19} r={2} /></>;
      break;
    case 'target':
      content = <><Circle cx={12} cy={12} r={9.5} /><Circle {...solid} cx={12} cy={12} r={2.5} /></>;
      break;
    case 'video':
      content = <><Rect {...solid} x={2} y={5} width={14} height={14} rx={2.8} /><Path {...solid} d="m15 9 6-3.3c.7-.4 1-.2 1 .6v11.4c0 .8-.3 1-1 .6L15 15Z" /></>;
      break;
    case 'laptop':
      content = <><Rect {...solid} x={4} y={4} width={16} height={12} rx={1.4} /><Path {...solid} d="m4.2 17-2.7 2.5c-.5.5-.2 1.2.5 1.2h20c.7 0 1-.7.5-1.2L19.8 17h-5.5l-.5 1.2h-3.6L9.7 17Z" /></>;
      break;
    case 'plus':
      content = <><Circle cx={12} cy={12} r={9.5} /><Path d="M12 6.5v11M6.5 12h11" /></>;
      break;
    case 'sparkles':
      content = <Path {...solid} d="M10.3 2.5c.4 0 .6.3.8.9l1.8 5.9c.2.7.7 1.2 1.4 1.4l4.4 1.6c.7.2.7.9 0 1.2l-4.4 1.7c-.7.2-1.2.7-1.4 1.4l-1.8 5.9c-.2.6-.4.9-.8.9s-.6-.3-.8-.9l-1.8-5.9c-.2-.7-.7-1.2-1.4-1.4l-4.4-1.7c-.7-.3-.7-1 0-1.2l4.4-1.6c.7-.2 1.2-.7 1.4-1.4L9.5 3.4c.2-.6.4-.9.8-.9ZM19.7 1l.8 2.6 2.3 1-.2.5-2.1.9-.8 2.6-.5.1-1-2.7-2.3-1 .1-.4 2.2-1 .9-2.6Z" />;
      break;
    case 'bolt':
      content = <Path {...solid} d="M13.4 1.5 4.9 13.1c-.5.7-.2 1.2.5 1.2h5.2l-.9 8.1c-.1.8.6 1.1 1.1.4L19.2 11c.5-.7.2-1.2-.6-1.2h-5.2l1.1-7.6c.1-.9-.6-1.3-1.1-.7Z" />;
      break;
    case 'check':
      content = <Path d="m5 12 4.5 4.5L19 7" strokeWidth={2.3} />;
      break;
    case 'close':
      content = <Path d="m6 6 12 12M18 6 6 18" />;
      break;
    case 'logo':
      // The app's own coral, not the September pink (Stitch, 2026-10-02).
      content = <>
        <Defs>
          <LinearGradient id={`${gradientId}pink`} x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0" stopColor={p.acd} /><Stop offset="1" stopColor={p.ac} />
          </LinearGradient>
          <LinearGradient id={`${gradientId}light`} x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0" stopColor={p.ac} /><Stop offset="1" stopColor={p.acd} />
          </LinearGradient>
        </Defs>
        <Path fill={`url(#${gradientId}pink)`} stroke="none" d="M2.8 1.7C.9 2.3-.1 9.1.2 14.7c.2 3.3.6 4.8 1.7 4.9 1.8.2 4.8-4.1 7.7-5.3 3.4 4 7.1 8.5 10.1 8.4 3-.2 4.2-7.1 4.2-11.6C23.9 5.5 22.7 2 21 2c-2.6-.1-5.6 3.7-8.9 6.1C8.1 3.9 5.1.9 2.8 1.7Z" />
        <Path fill={`url(#${gradientId}light)`} stroke="none" opacity={0.82} d="M9.6 14.3c2.7-3.3 5.8-4.9 9-4.7 1.9.1 3.7.7 5.3 1.5 0 4.5-1.2 11.4-4.2 11.6-3 .1-6.7-4.4-10.1-8.4Z" />
      </>;
      break;
    default:
      content = <Circle cx={12} cy={12} r={9} />;
  }
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...(Platform.OS === 'web' ? {} : { accessible: false })} aria-hidden={true} style={{ pointerEvents: 'none' }}>{content}</Svg>;
}
