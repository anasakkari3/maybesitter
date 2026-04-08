'use client';

import { FormEvent, useEffect, useState } from 'react';
import { CaptureSource, ItemPriority, Task } from '@/types';
import { useApp } from '@/context/AppContext';
import {
  DuplicateMatch,
  findDuplicateItems,
  parseNaturalLanguageCapture,
} from '@/utils/captureParser';

const priorities: { value: ItemPriority; label: string; description: string; color: string; bg: string; border: string }[] = [
  {
    value: 'must',
    label: 'Must Do',
    description: 'Has real consequences if skipped today',
    color: 'text-red-700',
    bg: 'bg-red-50',
    border: 'border-red-400',
  },
  {
    value: 'should',
    label: 'Should Do',
    description: 'Important but flexible - can shift without disaster',
    color: 'text-orange-700',
    bg: 'bg-orange-50',
    border: 'border-orange-400',
  },
  {
    value: 'nice',
    label: 'Nice To Do',
    description: 'Would be great but totally okay to skip',
    color: 'text-blue-700',
    bg: 'bg-blue-50',
    border: 'border-blue-400',
  },
];

const sourceOptions: { value: CaptureSource; label: string; description: string }[] = [
  { value: 'text', label: 'Text', description: 'Parse a natural sentence' },
  { value: 'manual', label: 'Manual', description: 'Fill fields yourself' },
  { value: 'voice', label: 'Voice', description: 'Paste dictated text' },
];

function formatDate(date: string): string {
  if (!date) return 'No date';
  return date;
}

function appendUniqueNote(existing: string, note: string): string {
  if (!note.trim()) return existing;
  if (!existing.trim()) return note.trim();
  if (existing.toLowerCase().includes(note.trim().toLowerCase())) return existing;
  return `${existing.trim()}\n${note.trim()}`;
}

export default function TaskModal() {
  const {
    showTaskModal,
    editingTask,
    tasks,
    user,
    closeTaskModal,
    addTask,
    updateTask,
    openEditTask,
  } = useApp();

  const [source, setSource] = useState<CaptureSource>('text');
  const [naturalInput, setNaturalInput] = useState('');
  const [parserNotes, setParserNotes] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<ItemPriority>('should');
  const [dueDate, setDueDate] = useState('');
  const [reminderTime, setReminderTime] = useState('');
  const [roughTiming, setRoughTiming] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([]);
  const [isCaptureSubmitting, setIsCaptureSubmitting] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  useEffect(() => {
    if (editingTask) {
      setSource(editingTask.source || 'manual');
      setNaturalInput('');
      setParserNotes([]);
      setTitle(editingTask.title);
      setDescription(editingTask.description || '');
      setPriority(editingTask.priority);
      setDueDate(editingTask.dueDate || '');
      setReminderTime(editingTask.reminderTime || '');
      setRoughTiming(editingTask.roughTiming || '');
    } else {
      setSource('text');
      setNaturalInput('');
      setParserNotes([]);
      setTitle('');
      setDescription('');
      setPriority('should');
      setDueDate('');
      setReminderTime('');
      setRoughTiming('');
    }
    setErrors({});
    setDuplicateMatches([]);
  }, [editingTask, showTaskModal]);

  const applyNaturalInput = (value: string, nextSource: CaptureSource = source) => {
    setNaturalInput(value);
    setDuplicateMatches([]);

    if (!value.trim()) {
      setParserNotes([]);
      return;
    }

    const parsed = parseNaturalLanguageCapture(value, {
      defaultReminderTime: user?.preferences.reminderTime,
      source: nextSource,
    });

    setTitle(parsed.title);
    setDueDate(parsed.dueDate);
    setReminderTime(parsed.reminderTime);
    setRoughTiming(parsed.roughTiming);
    setParserNotes(parsed.notes);
    if (parsed.priority) setPriority(parsed.priority);
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!title.trim()) newErrors.title = 'Title is required';
    if (title.trim().length > 120) newErrors.title = 'Title must be under 120 characters';
    return newErrors;
  };

  const getPayload = () => ({
    title: title.trim(),
    description: description.trim(),
    priority,
    dueDate,
    reminderTime,
    roughTiming: roughTiming.trim(),
    source,
  });

  const saveItem = async (forceCreate = false) => {
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    const payload = getPayload();

    if (!editingTask && !forceCreate) {
      const matches = findDuplicateItems(payload, tasks);
      if (matches.length > 0) {
        setDuplicateMatches(matches);
        return;
      }
    }

    if (editingTask) {
      updateTask(editingTask.id, payload);
      closeTaskModal();
      return;
    }

    // Text and voice: route through /api/capture
    if (source !== 'manual' && naturalInput.trim()) {
      setIsCaptureSubmitting(true);
      setCaptureError(null);
      try {
        const response = await fetch('/api/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: naturalInput.trim() }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error || `Capture failed with ${response.status}`);
        window.dispatchEvent(new Event('maybesitter:capture-complete'));
        closeTaskModal();
      } catch (err) {
        setCaptureError(err instanceof Error ? err.message : 'Capture failed');
      } finally {
        setIsCaptureSubmitting(false);
      }
      return;
    }

    // Manual: route through addTask → /api/commitment/create
    addTask(payload);
    closeTaskModal();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await saveItem(false);
  };

  const mergeIntoExisting = (match: Task) => {
    const payload = getPayload();
    updateTask(match.id, {
      description: appendUniqueNote(match.description, payload.description),
      priority: match.priority === 'nice' && payload.priority !== 'nice' ? payload.priority : match.priority,
      dueDate: match.dueDate || payload.dueDate,
      reminderTime: match.reminderTime || payload.reminderTime,
      roughTiming: match.roughTiming || payload.roughTiming,
      source: match.source || payload.source,
    });
    closeTaskModal();
  };

  if (!showTaskModal) return null;

  const showNaturalInput = !editingTask && source !== 'manual';
  const selectedPriority = priorities.find((c) => c.value === priority);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 p-6">
          <h2 className="text-xl font-bold text-gray-800">
            {editingTask ? 'Edit item' : 'Capture item'}
          </h2>
          <button
            onClick={closeTaskModal}
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 p-6">
          {!editingTask && (
            <div>
              <label className="mb-2 block text-sm font-semibold text-gray-700">Capture source</label>
              <div className="grid grid-cols-3 gap-2">
                {sourceOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setSource(option.value);
                      setDuplicateMatches([]);
                      if (option.value !== 'manual') applyNaturalInput(naturalInput, option.value);
                    }}
                    className={`rounded-lg border p-2 text-left transition-colors ${
                      source === option.value
                        ? 'border-gray-900 bg-gray-900 text-white'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <span className="block text-xs font-bold">{option.label}</span>
                    <span className={`mt-0.5 block text-[11px] ${source === option.value ? 'text-gray-200' : 'text-gray-400'}`}>
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {showNaturalInput && (
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-700">
                {source === 'voice' ? 'Voice transcript' : 'Natural language capture'}
              </label>
              <textarea
                value={naturalInput}
                onChange={(e) => applyNaturalInput(e.target.value)}
                placeholder={source === 'voice' ? 'Paste a dictated note, e.g. Call Ahmad tomorrow evening' : 'Try: Call Ahmad tomorrow evening'}
                rows={2}
                className="w-full resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-base text-gray-800 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                I will fill the fields below. Adjust anything that looks wrong.
              </p>
            </div>
          )}

          {duplicateMatches.length > 0 && (
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-4">
              <p className="text-sm font-bold text-orange-900">Possible duplicate</p>
              <p className="mt-1 text-xs text-orange-800">
                This looks similar to an active item. Merge into the existing item, ignore the new capture, or create it anyway.
              </p>
              <div className="mt-3 space-y-2">
                {duplicateMatches.map((match) => (
                  <div key={match.item.id} className="rounded-lg bg-white p-3 text-xs text-gray-700">
                    <p className="font-semibold">{match.item.title}</p>
                    <p className="mt-0.5 text-gray-500">
                      {match.reason} - {formatDate(match.item.dueDate)} - {Math.round(match.score * 100)}% match
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => mergeIntoExisting(match.item)}
                        className="rounded-lg bg-orange-600 px-3 py-1.5 font-semibold text-white hover:bg-orange-700"
                      >
                        Merge into existing
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          closeTaskModal();
                          openEditTask(match.item);
                        }}
                        className="rounded-lg bg-gray-100 px-3 py-1.5 font-semibold text-gray-700 hover:bg-gray-200"
                      >
                        Edit existing
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={closeTaskModal}
                  className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
                >
                  Ignore new item
                </button>
                <button
                  type="button"
                  onClick={() => saveItem(true)}
                  className="rounded-lg bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800"
                >
                  Create anyway
                </button>
              </div>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-sm font-semibold text-gray-700">
              Item title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setDuplicateMatches([]);
              }}
              placeholder="What do you need Maybesitter to track?"
              className={`w-full rounded-xl border bg-gray-50 px-4 py-3 text-base text-gray-800 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.title ? 'border-red-400 bg-red-50' : 'border-gray-200'
              }`}
              autoFocus
            />
            {errors.title && (
              <p className="mt-1 text-xs text-red-500">{errors.title}</p>
            )}
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-gray-700">
              How urgent is this?
            </label>
            <div className="grid grid-cols-3 gap-2">
              {priorities.map((cat) => (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => setPriority(cat.value)}
                  className={`rounded-xl border-2 p-3 text-center transition-all ${
                    priority === cat.value
                      ? `${cat.bg} ${cat.border} ${cat.color}`
                      : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                  }`}
                >
                  <div className="text-sm font-semibold">{cat.label}</div>
                </button>
              ))}
            </div>
            <p className={`mt-2 text-xs ${selectedPriority?.color}`}>
              {selectedPriority?.description}
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold text-gray-700">
              Notes <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add any context or details..."
              rows={3}
              className="w-full resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-gray-800 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-700">
                Due date
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => {
                  setDueDate(e.target.value);
                  setDuplicateMatches([]);
                }}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-700">
                Reminder time
              </label>
              <input
                type="time"
                value={reminderTime}
                onChange={(e) => setReminderTime(e.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold text-gray-700">
              Rough timing <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={roughTiming}
              onChange={(e) => setRoughTiming(e.target.value)}
              placeholder="later today, tomorrow evening, this week"
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {parserNotes.length > 0 && (
              <div className="mt-2 rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
                {parserNotes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            )}
          </div>

          {captureError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              {captureError}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={closeTaskModal}
              className="flex-1 rounded-xl bg-gray-100 px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isCaptureSubmitting}
              className="flex-1 rounded-xl bg-green-500 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-green-600"
            >
              {isCaptureSubmitting ? 'Capturing...' : editingTask ? 'Save item' : 'Capture item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
