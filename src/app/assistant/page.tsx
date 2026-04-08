import AgendaPanel from '@/components/AgendaPanel';
import AssistantPanel from '@/components/AssistantPanel';
import CommitmentReview from '@/components/CommitmentReview';

export default function AssistantPage() {
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-2xl font-bold text-gray-900">Maybesitter</h1>
        <p className="mt-2 text-sm text-gray-600">
          A small place to capture commitments and see what needs attention.
        </p>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
          <div className="space-y-6">
            <AssistantPanel />
            <AgendaPanel />
          </div>
          <CommitmentReview />
        </div>
      </div>
    </main>
  );
}
