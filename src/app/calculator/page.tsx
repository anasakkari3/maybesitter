'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import Navbar from '@/components/Navbar';
import { developerPagesEnabled } from '@/utils/developerPages';

const PRICE_PER_USER = 4.99;
const BREAKEVEN_USERS = 300;

const milestones = [
  { users: 100, label: '100 users', note: 'Proof of concept' },
  { users: 300, label: '300 users', note: 'Break-even' },
  { users: 500, label: '500 users', note: 'Profitable' },
  { users: 1000, label: '1,000 users', note: 'Scale phase' },
  { users: 2500, label: '2,500 users', note: 'Series A territory' },
  { users: 5000, label: '5,000 users', note: 'Sustainable business' },
];

export default function CalculatorPage() {
  const { isAuthenticated } = useApp();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  const [projectedUsers, setProjectedUsers] = useState(500);
  const [conversionRate, setConversionRate] = useState(20);
  const [monthlyFixedCosts, setMonthlyFixedCosts] = useState(150);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && (!isAuthenticated || !developerPagesEnabled)) {
      router.replace('/dashboard');
    }
  }, [mounted, isAuthenticated, router]);

  const calcs = useMemo(() => {
    const premiumSubscribers = Math.round(projectedUsers * (conversionRate / 100));
    const freeUsers = projectedUsers - premiumSubscribers;
    const monthlyRevenue = premiumSubscribers * PRICE_PER_USER;
    const annualRevenue = monthlyRevenue * 12;
    const monthlyProfit = monthlyRevenue - monthlyFixedCosts;
    const annualProfit = monthlyProfit * 12;
    const isProfitable = monthlyRevenue >= monthlyFixedCosts;
    const breakevenUsers = Math.ceil(monthlyFixedCosts / (PRICE_PER_USER * (conversionRate / 100)));
    const freePercent = projectedUsers > 0 ? Math.round((freeUsers / projectedUsers) * 100) : 80;
    const premiumPercent = 100 - freePercent;

    return { premiumSubscribers, freeUsers, monthlyRevenue, annualRevenue, monthlyProfit, annualProfit, isProfitable, breakevenUsers, freePercent, premiumPercent };
  }, [projectedUsers, conversionRate, monthlyFixedCosts]);

  const formatCurrency = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

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
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-black text-gray-800">Business Model Calculator</h1>
          <p className="text-gray-500 mt-1">Model revenue at different user counts. Drag sliders to see live projections.</p>
        </div>

        {/* Main inputs */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6 space-y-6">
          {/* Users slider */}
          <div>
            <div className="flex justify-between items-center mb-3">
              <label className="text-sm font-bold text-gray-700">Projected Users</label>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-black text-blue-600">{projectedUsers.toLocaleString()}</span>
                <span className="text-sm text-gray-500">users</span>
              </div>
            </div>
            <input
              type="range"
              min={100}
              max={5000}
              step={50}
              value={projectedUsers}
              onChange={(e) => setProjectedUsers(Number(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>100</span>
              <span>5,000</span>
            </div>
          </div>

          {/* Conversion rate */}
          <div>
            <div className="flex justify-between items-center mb-3">
              <label className="text-sm font-bold text-gray-700">Premium Conversion Rate</label>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-black text-purple-600">{conversionRate}%</span>
              </div>
            </div>
            <input
              type="range"
              min={5}
              max={50}
              step={1}
              value={conversionRate}
              onChange={(e) => setConversionRate(Number(e.target.value))}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-purple-500"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>5%</span>
              <span>50%</span>
            </div>
          </div>

          {/* Monthly costs */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm font-bold text-gray-700">Monthly Fixed Costs</label>
              <span className="text-sm text-gray-500">e.g. hosting, tools, subscriptions</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-gray-500 font-semibold">$</span>
              <input
                type="number"
                min={0}
                max={10000}
                value={monthlyFixedCosts}
                onChange={(e) => setMonthlyFixedCosts(Number(e.target.value))}
                className="flex-1 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              />
              <span className="text-gray-500 text-sm">/ mo</span>
            </div>
          </div>
        </div>

        {/* Live calculation results */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Premium Subscribers', value: calcs.premiumSubscribers.toLocaleString(), color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-100' },
            { label: 'Monthly Revenue', value: formatCurrency(calcs.monthlyRevenue), color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-100' },
            { label: 'Annual Revenue', value: formatCurrency(calcs.annualRevenue), color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-100' },
            { label: 'Monthly Profit', value: formatCurrency(calcs.monthlyProfit), color: calcs.isProfitable ? 'text-green-600' : 'text-red-600', bg: calcs.isProfitable ? 'bg-green-50' : 'bg-red-50', border: calcs.isProfitable ? 'border-green-100' : 'border-red-100' },
          ].map((stat) => (
            <div key={stat.label} className={`${stat.bg} border ${stat.border} rounded-xl p-4 text-center`}>
              <div className={`text-2xl font-black ${stat.color}`}>{stat.value}</div>
              <div className="text-xs text-gray-500 mt-1">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Profitability message */}
        <div className={`rounded-2xl p-5 mb-6 flex items-center gap-4 ${calcs.isProfitable ? 'bg-green-50 border border-green-200' : 'bg-orange-50 border border-orange-200'}`}>
          <span className="text-3xl">{calcs.isProfitable ? '🎉' : '📈'}</span>
          <div>
            {calcs.isProfitable ? (
              <p className="font-bold text-green-800">
                At {projectedUsers.toLocaleString()} users, you&apos;re profitable by {formatCurrency(calcs.monthlyProfit)}/mo!
              </p>
            ) : (
              <p className="font-bold text-orange-800">
                You need {calcs.breakevenUsers.toLocaleString()} users to break even at this conversion rate.
              </p>
            )}
            <p className={`text-sm mt-0.5 ${calcs.isProfitable ? 'text-green-700' : 'text-orange-700'}`}>
              Break-even: ~{calcs.breakevenUsers.toLocaleString()} users · Price: ${PRICE_PER_USER}/mo per premium user
            </p>
          </div>
        </div>

        {/* User split bar */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">User Mix</h2>
          <div className="w-full h-10 flex rounded-xl overflow-hidden mb-3">
            <div
              className="bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-600 transition-all"
              style={{ width: `${calcs.freePercent}%` }}
            >
              {calcs.freePercent > 15 ? `Free ${calcs.freePercent}%` : ''}
            </div>
            <div
              className="bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center text-xs font-bold text-white transition-all"
              style={{ width: `${calcs.premiumPercent}%` }}
            >
              {calcs.premiumPercent > 10 ? `Premium ${calcs.premiumPercent}%` : ''}
            </div>
          </div>
          <div className="flex justify-between text-sm text-gray-600">
            <span>{calcs.freeUsers.toLocaleString()} free users</span>
            <span>{calcs.premiumSubscribers.toLocaleString()} premium ({formatCurrency(calcs.monthlyRevenue)}/mo)</span>
          </div>
        </div>

        {/* Revenue milestones table */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">Revenue Milestones</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-100">
                  <th className="pb-3 text-xs font-bold text-gray-500 uppercase tracking-wide">Users</th>
                  <th className="pb-3 text-xs font-bold text-gray-500 uppercase tracking-wide text-right">Premium</th>
                  <th className="pb-3 text-xs font-bold text-gray-500 uppercase tracking-wide text-right">Monthly</th>
                  <th className="pb-3 text-xs font-bold text-gray-500 uppercase tracking-wide text-right">Annual</th>
                  <th className="pb-3 text-xs font-bold text-gray-500 uppercase tracking-wide">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {milestones.map((ms) => {
                  const prem = Math.round(ms.users * (conversionRate / 100));
                  const monthly = prem * PRICE_PER_USER;
                  const annual = monthly * 12;
                  const profit = monthly - monthlyFixedCosts;
                  const isActive = projectedUsers >= ms.users;
                  return (
                    <tr key={ms.users} className={isActive ? 'bg-blue-50/30' : ''}>
                      <td className="py-3 font-semibold text-gray-800">{ms.label}</td>
                      <td className="py-3 text-right text-gray-700">{prem.toLocaleString()}</td>
                      <td className="py-3 text-right text-gray-700">{formatCurrency(monthly)}</td>
                      <td className="py-3 text-right font-semibold text-gray-800">{formatCurrency(annual)}</td>
                      <td className="py-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          profit >= 0 ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                        }`}>
                          {ms.note}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            * Assumes {conversionRate}% conversion rate and ${monthlyFixedCosts}/mo fixed costs.
          </p>
        </div>
      </main>
    </div>
  );
}
