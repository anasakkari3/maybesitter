import {
  clearCommitments,
  createCommitmentFromItem,
  getUnifiedAppSnapshot,
} from '../../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  clearCommitments();
  createCommitmentFromItem({
    title: 'Pay electricity bill',
    description: 'Due by end of month or service gets cut',
    priority: 'must',
    dueDate: new Date().toISOString().slice(0, 10),
    reminderTime: '09:00',
  });
  createCommitmentFromItem({
    title: 'Reply to email from landlord',
    description: 'About lease renewal questions',
    priority: 'should',
    dueDate: new Date().toISOString().slice(0, 10),
    reminderTime: '11:00',
  });
  createCommitmentFromItem({
    title: 'Read that book chapter',
    priority: 'nice',
  });

  return Response.json(await getUnifiedAppSnapshot());
}
