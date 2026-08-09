export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    status: 'ok',
    service: 'maybesitter-pilot-backend',
    timestamp: new Date().toISOString(),
  });
}
