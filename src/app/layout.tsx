import type { Metadata } from 'next';
import './globals.css';
import { AppProvider } from '@/context/AppContext';

export const metadata: Metadata = {
  title: 'Maybesitter — Clarity for Your Chaotic Day',
  description:
    'Task management built for ADHD and neurodivergent users. The Must / Should / Nice priority system helps you decide what actually matters today.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
