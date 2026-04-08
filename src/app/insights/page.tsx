'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import Navbar from '@/components/Navbar';
import Link from 'next/link';
import { developerPagesEnabled } from '@/utils/developerPages';

const risks = [
  {
    risk: 'Low adoption',
    likelihood: 'High',
    severity: 'High',
    mitigation: 'Nail one underserved user segment (ADHD). Build in public to create accountability and community.',
  },
  {
    risk: 'Low retention',
    likelihood: 'Medium',
    severity: 'High',
    mitigation: 'Daily Digest creates a daily habit loop. Weekly analytics give users a reason to return.',
  },
  {
    risk: 'Privacy concerns',
    likelihood: 'Low',
    severity: 'Medium',
    mitigation: 'Single-user server storage keeps data scoped to the local deployment. Make the boundary explicit.',
  },
  {
    risk: 'Feature bloat',
    likelihood: 'Medium',
    severity: 'Medium',
    mitigation: 'Strict feature gating. Only add features requested by 3+ active users. Say no by default.',
  },
  {
    risk: 'Competition from large apps',
    likelihood: 'High',
    severity: 'Low',
    mitigation: 'Large apps serve the average user. We serve neurodivergent users who hate large apps.',
  },
];

const phase1Metrics = [
  { label: 'Beta Users', current: 47, target: 100, suffix: '', color: 'bg-blue-500' },
  { label: '7-Day Retention', current: 44, target: 50, suffix: '%', color: 'bg-green-500' },
  { label: 'App Rating', current: 84, target: 100, suffix: '', display: '4.2 / 5', color: 'bg-purple-500' },
  { label: '"Helps me prioritize"', current: 78, target: 100, suffix: '%', color: 'bg-orange-500' },
];

const roadmap = [
  {
    phase: 'Phase 1',
    title: 'Core MVP',
    status: 'current',
    timeframe: 'Now — Month 3',
    items: ['Must/Should/Nice system', 'Daily Digest', 'Basic analytics', 'server-backed data', 'ADHD-friendly UX'],
  },
  {
    phase: 'Phase 2',
    title: 'Growth & Stickiness',
    status: 'upcoming',
    timeframe: 'Month 3 — 6',
    items: ['Cloud sync (optional)', 'Recurring tasks', 'Calendar integration', 'Mobile app (PWA)', 'Email digest'],
  },
  {
    phase: 'Phase 3',
    title: 'Monetization & Scale',
    status: 'future',
    timeframe: 'Month 6+',
    items: ['Premium subscription ($4.99/mo)', 'Team features', 'ADHD coach integrations', 'API for third-party apps'],
  },
];

const decisionFramework = [
  { metric: 'Users > 100', outcome: 'Continue building', status: 'green' },
  { metric: 'Retention > 50%', outcome: 'Invest in growth', status: 'green' },
  { metric: 'Users < 50 after 3 months', outcome: 'Pivot messaging or segment', status: 'red' },
  { metric: 'Retention < 30%', outcome: 'Rebuild onboarding & digest', status: 'red' },
  { metric: 'Users > 300', outcome: 'Launch premium tier', status: 'green' },
  { metric: 'Churn > 70%', outcome: 'Stop and research user needs', status: 'red' },
];

export default function InsightsPage() {
  const { isAuthenticated } = useApp();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && (!isAuthenticated || !developerPagesEnabled)) {
      router.replace('/dashboard');
    }
  }, [mounted, isAuthenticated, router]);

  if (!mounted || !isAuthenticated || !developerPagesEnabled) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-black text-gray-800">Project Insights &amp; Strategy</h1>
          <p className="text-gray-500 mt-1">How we&apos;re building Maybesitter with intention.</p>
        </div>

        {/* Section 1: The Real Problem */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-black text-gray-800 mb-4">The Real Problem</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { icon: '🧠', title: 'Executive dysfunction', desc: "For people with ADHD, knowing what to do and being able to start doing it are two completely different neurological challenges." },
              { icon: '📋', title: 'Task paralysis', desc: "When everything feels equally urgent, the brain freezes. Most to-do apps make this worse by showing everything at once." },
              { icon: '⏰', title: 'Time blindness', desc: "ADHD users often experience time as only 'now' and 'not now,' making future-oriented task planning feel impossible." },
              { icon: '😔', title: 'Shame spirals', desc: "Unused to-do apps become evidence of failure, creating avoidance that makes productivity worse, not better." },
            ].map((item) => (
              <div key={item.title} className="flex gap-3 p-4 bg-gray-50 rounded-xl">
                <span className="text-2xl flex-shrink-0">{item.icon}</span>
                <div>
                  <h3 className="font-bold text-gray-800 text-sm mb-1">{item.title}</h3>
                  <p className="text-gray-600 text-xs leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Section 2: Phase 1 Metrics */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-black text-gray-800 mb-5">Phase 1 Success Metrics</h2>
          <div className="space-y-4">
            {phase1Metrics.map((metric) => (
              <div key={metric.label}>
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-sm font-semibold text-gray-700">{metric.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-gray-800">
                      {metric.display || `${metric.current}${metric.suffix}`}
                    </span>
                    <span className="text-xs text-gray-400">/ {metric.display ? '5.0' : `${metric.target}${metric.suffix}`}</span>
                  </div>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-3">
                  <div
                    className={`${metric.color} h-3 rounded-full transition-all`}
                    style={{ width: `${Math.min(metric.current, 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-4">* Simulated data for demonstration purposes</p>
        </div>

        {/* Section 3: Risk Matrix */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-black text-gray-800 mb-5">Risk &amp; Mitigation Matrix</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-100">
                  <th className="pb-3 text-xs font-bold text-gray-500 uppercase tracking-wide">Risk</th>
                  <th className="pb-3 text-xs font-bold text-gray-500 uppercase tracking-wide">Likelihood</th>
                  <th className="pb-3 text-xs font-bold text-gray-500 uppercase tracking-wide">Severity</th>
                  <th className="pb-3 text-xs font-bold text-gray-500 uppercase tracking-wide">Mitigation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {risks.map((risk) => (
                  <tr key={risk.risk} className="hover:bg-gray-50">
                    <td className="py-3 pr-4 font-semibold text-gray-800 whitespace-nowrap">{risk.risk}</td>
                    <td className="py-3 pr-4">
                      <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                        risk.likelihood === 'High' ? 'bg-red-100 text-red-700' :
                        risk.likelihood === 'Medium' ? 'bg-orange-100 text-orange-700' :
                        'bg-green-100 text-green-700'
                      }`}>
                        {risk.likelihood}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                        risk.severity === 'High' ? 'bg-red-100 text-red-700' :
                        risk.severity === 'Medium' ? 'bg-orange-100 text-orange-700' :
                        'bg-green-100 text-green-700'
                      }`}>
                        {risk.severity}
                      </span>
                    </td>
                    <td className="py-3 text-gray-600 text-xs leading-relaxed">{risk.mitigation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section 4: Roadmap */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-black text-gray-800 mb-5">Development Roadmap</h2>
          <div className="grid md:grid-cols-3 gap-4">
            {roadmap.map((phase) => (
              <div
                key={phase.phase}
                className={`rounded-xl p-5 border-2 ${
                  phase.status === 'current'
                    ? 'border-blue-500 bg-blue-50'
                    : phase.status === 'upcoming'
                    ? 'border-orange-200 bg-orange-50'
                    : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    phase.status === 'current' ? 'bg-blue-500 text-white' :
                    phase.status === 'upcoming' ? 'bg-orange-400 text-white' :
                    'bg-gray-400 text-white'
                  }`}>
                    {phase.status === 'current' ? '● CURRENT' : phase.status === 'upcoming' ? '○ NEXT' : '○ FUTURE'}
                  </span>
                </div>
                <h3 className="font-black text-gray-800 mb-0.5">{phase.phase}</h3>
                <p className="text-sm font-semibold text-gray-700 mb-1">{phase.title}</p>
                <p className="text-xs text-gray-500 mb-3">{phase.timeframe}</p>
                <ul className="space-y-1">
                  {phase.items.map((item) => (
                    <li key={item} className="text-xs text-gray-700 flex items-start gap-1.5">
                      <span className="text-gray-400 mt-0.5">•</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Section 5: Decision Framework */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-black text-gray-800 mb-2">Decision Framework</h2>
          <p className="text-sm text-gray-500 mb-5">Data-driven go/no-go criteria for continuing or pivoting.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            {decisionFramework.map((item) => (
              <div
                key={item.metric}
                className={`flex items-start gap-3 p-4 rounded-xl border ${
                  item.status === 'green'
                    ? 'bg-green-50 border-green-200'
                    : 'bg-red-50 border-red-200'
                }`}
              >
                <span className={`text-xs font-black mt-0.5 w-5 h-5 flex-shrink-0 rounded-full flex items-center justify-center ${
                  item.status === 'green' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
                }`}>
                  {item.status === 'green' ? '→' : '✕'}
                </span>
                <div>
                  <p className={`text-sm font-bold ${item.status === 'green' ? 'text-green-800' : 'text-red-800'}`}>
                    {item.metric}
                  </p>
                  <p className={`text-xs mt-0.5 ${item.status === 'green' ? 'text-green-700' : 'text-red-700'}`}>
                    {item.outcome}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA to calculator */}
        <div className="bg-gradient-to-r from-blue-500 to-purple-600 rounded-2xl p-6 text-white text-center">
          <h3 className="text-xl font-black mb-2">Want to see the numbers?</h3>
          <p className="text-blue-100 text-sm mb-4">Use the business calculator to model revenue at different user counts.</p>
          <Link
            href="/calculator"
            className="inline-flex items-center gap-2 bg-white text-gray-900 font-bold px-5 py-2.5 rounded-xl hover:bg-gray-100 transition-colors"
          >
            Open Calculator →
          </Link>
        </div>
      </main>
    </div>
  );
}
