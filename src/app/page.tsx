'use client';

import Link from 'next/link';
import { useState } from 'react';
import { developerPagesEnabled } from '@/utils/developerPages';

const painPoints = [
  {
    icon: '🌀',
    title: 'Everything feels urgent',
    desc: 'You open your to-do list and everything screams for attention at once.',
  },
  {
    icon: '⏰',
    title: 'Time blindness hits hard',
    desc: "You start one thing and suddenly it's 3pm and nothing important got done.",
  },
  {
    icon: '😰',
    title: 'Decision fatigue by noon',
    desc: "You spend more energy deciding *what* to do than actually doing things.",
  },
  {
    icon: '📋',
    title: 'Lists that mock you',
    desc: "Your to-do app has 47 items. You avoided it for 3 days. We get it.",
  },
];

const features = [
  {
    icon: '☀️',
    title: 'Daily Digest',
    desc: 'Start each day with a clear, calm overview of what actually needs to happen today.',
    color: 'bg-yellow-50 border-yellow-200',
  },
  {
    icon: '🎯',
    title: 'Smart Categories',
    desc: "Must / Should / Nice. Three buckets. Simple. Your brain will finally know where to look.",
    color: 'bg-red-50 border-red-200',
  },
  {
    icon: '📊',
    title: 'Weekly Analytics',
    desc: "See patterns in your productivity without judgment. Data that helps, not shames.",
    color: 'bg-blue-50 border-blue-200',
  },
  {
    icon: '🔔',
    title: 'Flexible Reminders',
    desc: 'Set reminders when you need them. No notification spam. You stay in control.',
    color: 'bg-purple-50 border-purple-200',
  },
  {
    icon: '🔒',
    title: 'Privacy First',
    desc: 'Your data lives on your device. No cloud. No selling your habits to advertisers.',
    color: 'bg-green-50 border-green-200',
  },
  {
    icon: '🧠',
    title: 'ADHD Friendly',
    desc: 'Designed with neurodivergent users in mind. Minimal friction, maximum clarity.',
    color: 'bg-orange-50 border-orange-200',
  },
];

const metrics = [
  { label: 'Target Users', current: 47, target: 100, color: 'bg-blue-500' },
  { label: 'Retention Rate', current: 44, target: 50, color: 'bg-green-500', suffix: '%' },
  { label: 'Avg App Rating', current: 84, target: 100, color: 'bg-purple-500', display: '4.2/5' },
  { label: '"Helps prioritize"', current: 78, target: 100, color: 'bg-orange-500', suffix: '%' },
];

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-white">
      {/* Sticky Navbar */}
      <nav className="sticky top-0 z-50 bg-white border-b border-gray-100 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">M</span>
              </div>
              <span className="text-xl font-bold text-gray-800">Maybesitter</span>
            </div>

            {/* Desktop nav */}
            <div className="hidden md:flex items-center space-x-6">
              <a href="#features" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">Features</a>
              <a href="#pricing" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">Pricing</a>
              <a href="#metrics" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">About</a>
              <Link
                href="/dashboard"
                className="bg-gradient-to-r from-blue-500 to-purple-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:from-blue-600 hover:to-purple-700 transition-all shadow-sm"
              >
                Open App
              </Link>
            </div>

            {/* Mobile menu button */}
            <button
              className="md:hidden p-2 text-gray-600"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={mobileMenuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
              </svg>
            </button>
          </div>
          {mobileMenuOpen && (
            <div className="md:hidden py-3 border-t border-gray-100 space-y-1">
              <a href="#features" onClick={() => setMobileMenuOpen(false)} className="block px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg">Features</a>
              <a href="#pricing" onClick={() => setMobileMenuOpen(false)} className="block px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg">Pricing</a>
              <Link href="/dashboard" className="block px-4 py-2 text-sm font-semibold text-blue-600 hover:bg-blue-50 rounded-lg">Open App</Link>
            </div>
          )}
        </div>
      </nav>

      {/* Hero */}
      <section className="bg-gradient-to-br from-slate-900 via-blue-900 to-purple-900 text-white py-20 lg:py-32">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <span className="inline-flex items-center gap-2 bg-blue-500/20 border border-blue-400/30 text-blue-300 text-xs font-semibold px-3 py-1.5 rounded-full mb-6">
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full" />
                Built for ADHD &amp; Neurodivergent Users
              </span>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black leading-tight mb-6">
                Clarity for Your{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400">
                  Chaotic Day
                </span>
              </h1>
              <p className="text-lg text-blue-100 mb-8 leading-relaxed max-w-xl">
                It&apos;s not that you forget. It&apos;s that everything feels equally urgent. Maybesitter helps you decide what actually matters today.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <Link
                  href="/dashboard"
                  className="inline-flex items-center justify-center gap-2 bg-white text-gray-900 font-bold px-6 py-3.5 rounded-xl hover:bg-gray-100 transition-colors shadow-lg"
                >
                  Start Free →
                </Link>
                <a
                  href="#features"
                  className="inline-flex items-center justify-center gap-2 bg-white/10 border border-white/20 text-white font-semibold px-6 py-3.5 rounded-xl hover:bg-white/20 transition-colors"
                >
                  See How It Works
                </a>
              </div>
            </div>

            {/* Task cards visual */}
            <div className="hidden lg:flex flex-col gap-3 max-w-sm ml-auto">
              <div className="bg-white/10 backdrop-blur border border-red-400/40 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 bg-red-400 rounded-full" />
                  <span className="text-red-300 text-xs font-bold uppercase tracking-wide">Must Do</span>
                </div>
                <p className="text-white font-semibold">Pay electricity bill</p>
                <p className="text-white/60 text-xs mt-1">Due today · 09:00 AM</p>
              </div>
              <div className="bg-white/10 backdrop-blur border border-orange-400/40 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 bg-orange-400 rounded-full" />
                  <span className="text-orange-300 text-xs font-bold uppercase tracking-wide">Should Do</span>
                </div>
                <p className="text-white font-semibold">Reply to landlord email</p>
                <p className="text-white/60 text-xs mt-1">Due tomorrow</p>
              </div>
              <div className="bg-white/10 backdrop-blur border border-blue-400/40 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 bg-blue-400 rounded-full" />
                  <span className="text-blue-300 text-xs font-bold uppercase tracking-wide">Nice To Do</span>
                </div>
                <p className="text-white font-semibold">Reorganize desk</p>
                <p className="text-white/60 text-xs mt-1">Whenever you feel like it</p>
              </div>
              <div className="bg-green-500/20 border border-green-400/40 rounded-xl p-3 flex items-center gap-3">
                <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center flex-shrink-0">
                  <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-green-300 text-sm line-through">Pick up kids from school</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Problem section */}
      <section className="py-20 bg-gray-50" id="problem">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-black text-gray-900 mb-4">Sound familiar?</h2>
            <p className="text-gray-500 max-w-xl mx-auto">
              If your brain works differently, standard to-do apps weren&apos;t built for you.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {painPoints.map((point, i) => (
              <div key={i} className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm">
                <div className="text-3xl mb-3">{point.icon}</div>
                <h3 className="font-bold text-gray-800 mb-2">{point.title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{point.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Solution section */}
      <section className="py-20 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-black text-gray-900 mb-4">
              The Must / Should / Nice System
            </h2>
            <p className="text-gray-500 max-w-xl mx-auto">
              Three simple buckets. One clear question: how bad is it if I skip this today?
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-6 text-center">
              <div className="w-12 h-12 bg-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-white font-black text-lg">!</span>
              </div>
              <h3 className="text-xl font-black text-red-700 mb-2">Must Do</h3>
              <p className="text-red-600 text-sm leading-relaxed">
                Real consequences if skipped. Bills. Appointments. Work deadlines. These get done first.
              </p>
            </div>
            <div className="bg-orange-50 border-2 border-orange-200 rounded-2xl p-6 text-center">
              <div className="w-12 h-12 bg-orange-500 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-white font-black text-lg">→</span>
              </div>
              <h3 className="text-xl font-black text-orange-700 mb-2">Should Do</h3>
              <p className="text-orange-600 text-sm leading-relaxed">
                Important, but flexible. Life won&apos;t fall apart today if this slips. Do it if energy allows.
              </p>
            </div>
            <div className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-6 text-center">
              <div className="w-12 h-12 bg-blue-500 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-white font-black text-sm">✓?</span>
              </div>
              <h3 className="text-xl font-black text-blue-700 mb-2">Nice To Do</h3>
              <p className="text-blue-600 text-sm leading-relaxed">
                Would be great, totally fine to skip. Your brain will stop catastrophizing once it sees these labeled right.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features section */}
      <section className="py-20 bg-gray-50" id="features">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-black text-gray-900 mb-4">Everything you need, nothing you don&apos;t</h2>
            <p className="text-gray-500 max-w-xl mx-auto">
              Designed for focus, not feature bloat.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((feature, i) => (
              <div key={i} className={`border rounded-xl p-6 ${feature.color}`}>
                <div className="text-3xl mb-3">{feature.icon}</div>
                <h3 className="font-bold text-gray-800 mb-2">{feature.title}</h3>
                <p className="text-gray-600 text-sm leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-20 bg-white" id="pricing">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-black text-gray-900 mb-4">Simple, honest pricing</h2>
            <p className="text-gray-500">Start free. Upgrade only if it helps.</p>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            {/* Free tier */}
            <div className="border-2 border-gray-200 rounded-2xl p-8">
              <h3 className="text-xl font-black text-gray-800 mb-1">Free</h3>
              <div className="text-4xl font-black text-gray-900 mb-4">$0<span className="text-lg font-normal text-gray-500">/mo</span></div>
              <ul className="space-y-3 mb-8">
                {[
                  'Unlimited tasks',
                  'Must / Should / Nice system',
                  'Daily digest',
                  'Basic analytics',
                  'Local storage (private)',
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-sm text-gray-700">
                    <span className="w-4 h-4 bg-green-100 text-green-600 rounded-full flex items-center justify-center text-xs">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                href="/dashboard"
                className="block w-full text-center py-3 border-2 border-gray-300 text-gray-700 font-semibold rounded-xl hover:border-gray-400 transition-colors"
              >
                Get Started Free
              </Link>
            </div>

            {/* Premium tier */}
            <div className="border-2 border-blue-500 rounded-2xl p-8 relative bg-gradient-to-br from-blue-50 to-purple-50">
              <span className="absolute -top-3 left-6 bg-gradient-to-r from-blue-500 to-purple-600 text-white text-xs font-bold px-3 py-1 rounded-full">
                COMING SOON
              </span>
              <h3 className="text-xl font-black text-gray-800 mb-1">Premium</h3>
              <div className="text-4xl font-black text-gray-900 mb-4">$4.99<span className="text-lg font-normal text-gray-500">/mo</span></div>
              <ul className="space-y-3 mb-8">
                {[
                  'Everything in Free',
                  'Cloud sync & backup',
                  'Advanced analytics',
                  'Recurring tasks',
                  'Calendar integration',
                  'Priority support',
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2 text-sm text-gray-700">
                    <span className="w-4 h-4 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
              <button className="block w-full text-center py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold rounded-xl opacity-60 cursor-not-allowed">
                Coming Soon
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Phase Metrics */}
      <section className="py-20 bg-gray-50" id="metrics">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-black text-gray-900 mb-3">Phase 1 Goals</h2>
            <p className="text-gray-500">We build in public. Here&apos;s where we&apos;re at.</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-5">
            {metrics.map((metric, i) => (
              <div key={i} className="bg-white border border-gray-200 rounded-xl p-5">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-semibold text-gray-700">{metric.label}</span>
                  <span className="text-sm font-bold text-gray-900">
                    {metric.display || (metric.suffix ? `${metric.current}${metric.suffix}` : metric.current)}
                  </span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2.5">
                  <div
                    className={`${metric.color} h-2.5 rounded-full transition-all`}
                    style={{ width: `${Math.min(metric.current, 100)}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Target: {metric.display ? '5.0/5' : `${metric.target}${metric.suffix || ''}`}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-20 bg-gradient-to-r from-blue-600 to-purple-600 text-white">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <h2 className="text-3xl sm:text-4xl font-black mb-4">Start Free Today</h2>
          <p className="text-blue-100 mb-8 text-lg">
            No credit card. No sign-up friction. Just clarity.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 bg-white text-gray-900 font-bold px-8 py-4 rounded-xl hover:bg-gray-100 transition-colors shadow-lg text-lg"
          >
            Open App →
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-gray-400 py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="flex items-center space-x-2">
              <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-xs">M</span>
              </div>
              <span className="text-white font-bold">Maybesitter</span>
            </div>
            <div className="flex items-center gap-5 text-sm">
              {developerPagesEnabled && (
                <>
                  <Link href="/insights" className="hover:text-white transition-colors">Insights</Link>
                  <Link href="/calculator" className="hover:text-white transition-colors">Calculator</Link>
                </>
              )}
              <Link href="/dashboard" className="hover:text-white transition-colors">Open App</Link>
            </div>
            <p className="text-xs text-gray-600">&copy; 2024 Maybesitter. Your data stays yours.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
