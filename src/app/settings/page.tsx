'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import Navbar from '@/components/Navbar';
import PilotTrustPanel from '@/components/PilotTrustPanel';
import { pilotIdentity } from '@/utils/pilotIdentity';

type Tab = 'profile' | 'preferences' | 'notifications' | 'data';

const timezones = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'Europe/Moscow', 'Asia/Tokyo', 'Asia/Shanghai',
  'Asia/Kolkata', 'Australia/Sydney', 'Pacific/Auckland',
];

export default function SettingsPage() {
  const { user, updateUser, clearTasks, removeAccount, isAuthenticated, exportData } = useApp();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('profile');

  // Profile state
  const [name, setName] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);

  // Preferences state
  const [reminderTime, setReminderTime] = useState('08:00');
  const [timezone, setTimezone] = useState('America/New_York');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [prefSaved, setPrefSaved] = useState(false);

  // Notifications state
  const [dailyDigest, setDailyDigest] = useState(true);
  const [browserNotifications, setBrowserNotifications] = useState(true);
  const [notifSaved, setNotifSaved] = useState(false);
  const [calendarUrl, setCalendarUrl] = useState('');
  const [calendarCopied, setCalendarCopied] = useState(false);

  // Confirm dialogs
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (typeof window !== 'undefined') {
      const participantId = pilotIdentity();
      const query = participantId ? `?participantId=${encodeURIComponent(participantId)}` : '';
      setCalendarUrl(`${window.location.origin}/api/calendar.ics${query}`);
    }
  }, []);

  useEffect(() => {
    if (mounted && !isAuthenticated) {
      router.push('/dashboard');
    }
  }, [mounted, isAuthenticated, router]);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setReminderTime(user.preferences.reminderTime || '08:00');
      setTimezone(user.preferences.timezone || 'America/New_York');
      setTheme(user.preferences.theme || 'light');
      setDailyDigest(user.preferences.dailyDigestEnabled ?? true);
      setBrowserNotifications(user.preferences.notificationsEnabled ?? true);
    }
  }, [user]);

  const handleSaveProfile = () => {
    if (!name.trim()) return;
    updateUser({ name: name.trim() });
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  };

  const handleSavePreferences = () => {
    updateUser({
      preferences: {
        ...user!.preferences,
        reminderTime,
        timezone,
        theme,
      },
    });
    setPrefSaved(true);
    setTimeout(() => setPrefSaved(false), 2000);
  };

  const handleSaveNotifications = async () => {
    let finalBrowserNotif = browserNotifications;

    // Request browser permission if user enabled it
    if (browserNotifications && typeof Notification !== 'undefined') {
      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        finalBrowserNotif = permission === 'granted';
        setBrowserNotifications(finalBrowserNotif);
      } else if (Notification.permission === 'denied') {
        finalBrowserNotif = false;
        setBrowserNotifications(false);
      }
    }

    updateUser({
      preferences: {
        ...user!.preferences,
        dailyDigestEnabled: dailyDigest,
        notificationsEnabled: finalBrowserNotif,
      },
    });
    setNotifSaved(true);
    setTimeout(() => setNotifSaved(false), 2000);
  };

  const handleExport = async () => {
    const data = await exportData();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `maybesitter-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyCalendarUrl = async () => {
    if (!calendarUrl) return;
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(calendarUrl);
    setCalendarCopied(true);
    setTimeout(() => setCalendarCopied(false), 2000);
  };

  const handleClearTasks = () => {
    clearTasks();
    setShowClearConfirm(false);
  };

  const handleDeleteAccount = () => {
    removeAccount();
    router.push('/dashboard');
  };

  const tabs: { value: Tab; label: string }[] = [
    { value: 'profile', label: 'Profile' },
    { value: 'preferences', label: 'Preferences' },
    { value: 'notifications', label: 'Notifications' },
    { value: 'data', label: 'Data' },
  ];

  if (!mounted || !isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-black text-gray-800">Settings</h1>
          <p className="text-gray-500 mt-1">Manage your local profile and preferences.</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-white border border-gray-200 rounded-xl p-1 mb-6 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                activeTab === tab.value
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Profile Tab */}
        {activeTab === 'profile' && (
          <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
            <h2 className="text-lg font-bold text-gray-800">Profile</h2>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Full Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Email Address</label>
              <input
                type="email"
                value={user?.email || ''}
                readOnly
                className="w-full px-4 py-3 bg-gray-100 border border-gray-200 rounded-xl text-gray-500 cursor-not-allowed"
              />
              <p className="text-xs text-gray-400 mt-1">Email cannot be changed.</p>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Member Since</label>
              <p className="text-sm text-gray-600">
                {user?.createdAt ? new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '-'}
              </p>
            </div>
            <button
              onClick={handleSaveProfile}
              className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                profileSaved
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-800 text-white hover:bg-gray-700'
              }`}
            >
              {profileSaved ? 'Saved' : 'Save changes'}
            </button>
          </div>
        )}

        {/* Preferences Tab */}
        {activeTab === 'preferences' && (
          <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
            <h2 className="text-lg font-bold text-gray-800">Preferences</h2>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Default Reminder Time</label>
              <input
                type="time"
                value={reminderTime}
                onChange={(e) => setReminderTime(e.target.value)}
                className="px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">Timezone</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              >
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-3">Theme</label>
              <div className="flex gap-3">
                {(['light', 'dark'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={`flex-1 py-3 rounded-xl border-2 text-sm font-semibold capitalize transition-all ${
                      theme === t
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {t === 'light' ? 'Light' : 'Dark'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">Changes apply instantly across all pages.</p>
            </div>
            <button
              onClick={handleSavePreferences}
              className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                prefSaved ? 'bg-green-500 text-white' : 'bg-gray-800 text-white hover:bg-gray-700'
              }`}
            >
              {prefSaved ? 'Saved' : 'Save preferences'}
            </button>
          </div>
        )}

        {/* Notifications Tab */}
        {activeTab === 'notifications' && (
          <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
            <h2 className="text-lg font-bold text-gray-800">Reminder delivery</h2>
            <p className="text-sm text-gray-500">
              Maybesitter currently supports in-app alerts while the app is open. Browser notifications are optional and require browser permission.
            </p>
            {[
              { label: 'Daily agenda banner', desc: 'Show the agenda prompt when overdue, due-today, or reminder-today items need awareness confirmation.', value: dailyDigest, onChange: setDailyDigest },
              { label: 'Browser reminders', desc: 'Use browser notifications for local reminder and escalation attempts when permission is granted.', value: browserNotifications, onChange: setBrowserNotifications },
            ].map((item) => (
              <div key={item.label} className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-gray-700">{item.label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
                </div>
                <button
                  onClick={() => item.onChange(!item.value)}
                  className={`relative mt-0.5 h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
                    item.value ? 'bg-blue-500' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${
                      item.value ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            ))}
            <button
              onClick={handleSaveNotifications}
              className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                notifSaved ? 'bg-green-500 text-white' : 'bg-gray-800 text-white hover:bg-gray-700'
              }`}
            >
              {notifSaved ? 'Saved' : 'Save reminder settings'}
            </button>
          </div>
        )}

        {/* Data Tab */}
        {activeTab === 'data' && (
          <div className="space-y-4">
            <PilotTrustPanel />
            <div className="bg-white border border-blue-200 rounded-2xl p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-1">iPhone Calendar Feed</h2>
              <p className="text-sm text-gray-500 mb-4">
                Subscribe to your active Maybesitter items from Apple Calendar. Timed items use their reminder time, dated items without time are all-day, and unscheduled items appear on today.
              </p>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600 break-all">
                {calendarUrl || '/api/calendar.ics'}
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  onClick={handleCopyCalendarUrl}
                  className="px-4 py-2 bg-blue-500 text-white text-sm font-semibold rounded-lg hover:bg-blue-600 transition-colors"
                >
                  {calendarCopied ? 'Copied' : 'Copy calendar URL'}
                </button>
                {calendarUrl && (
                  <a
                    href={calendarUrl.replace(/^https?:/, 'webcal:')}
                    className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-200 transition-colors text-center"
                  >
                    Open as subscribed calendar
                  </a>
                )}
              </div>
              <p className="mt-3 text-xs text-gray-400">
                The phone must be able to reach this app URL. A localhost URL only works on the same machine.
              </p>
            </div>

            <div className="bg-white border border-gray-200 rounded-2xl p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-1">Export Your Data</h2>
              <p className="text-sm text-gray-500 mb-4">Download all your items, reminder attempts, and settings as a JSON file.</p>
              <button
                onClick={handleExport}
                className="flex items-center gap-2 px-5 py-2.5 bg-blue-500 text-white text-sm font-semibold rounded-xl hover:bg-blue-600 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download JSON Export
              </button>
            </div>

            <div className="bg-white border border-orange-200 rounded-2xl p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-1">Clear all items</h2>
              <p className="text-sm text-gray-500 mb-4">Remove all captured items from your list. Your profile remains.</p>
              {!showClearConfirm ? (
                <button
                  onClick={() => setShowClearConfirm(true)}
                  className="px-5 py-2.5 bg-orange-100 text-orange-700 text-sm font-semibold rounded-xl hover:bg-orange-200 transition-colors"
                >
                  Clear all items
                </button>
              ) : (
                <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
                  <p className="text-sm text-orange-800 font-semibold mb-3">Are you sure? This cannot be undone.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleClearTasks}
                      className="px-4 py-2 bg-orange-500 text-white text-sm font-semibold rounded-lg hover:bg-orange-600"
                    >
                      Yes, clear items
                    </button>
                    <button
                      onClick={() => setShowClearConfirm(false)}
                      className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-200"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white border border-red-200 rounded-2xl p-6">
              <h2 className="text-lg font-bold text-gray-800 mb-1">Reset Local Profile</h2>
              <p className="text-sm text-gray-500 mb-4">Permanently reset your local profile and all data.</p>
              {!showDeleteConfirm ? (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-5 py-2.5 bg-red-100 text-red-700 text-sm font-semibold rounded-xl hover:bg-red-200 transition-colors"
                >
                  Reset local profile
                </button>
              ) : (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <p className="text-sm text-red-800 font-semibold mb-3">This will delete everything and cannot be undone.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleDeleteAccount}
                      className="px-4 py-2 bg-red-500 text-white text-sm font-semibold rounded-lg hover:bg-red-600"
                    >
                      Yes, delete everything
                    </button>
                    <button
                      onClick={() => setShowDeleteConfirm(false)}
                      className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-semibold rounded-lg hover:bg-gray-200"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
