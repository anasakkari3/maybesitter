'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';

export default function LoginPage() {
  const router = useRouter();
  const { refreshTasks } = useApp();

  useEffect(() => {
    refreshTasks();
    router.replace('/dashboard');
  }, [refreshTasks, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-xl font-bold text-gray-900">Single-user mode is active</h1>
        <p className="mt-2 text-sm text-gray-500">
          Maybesitter no longer accepts passwords in this MVP. Your local server profile is opening now.
        </p>
      </div>
    </div>
  );
}
