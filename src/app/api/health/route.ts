export const dynamic = "force-dynamic";

export async function GET() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return Response.json({ ok: true, db: "not configured" });
  }
  try {
    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, db: "connected" });
  } catch {
    return Response.json({ ok: false, db: "error" }, { status: 500 });
  }
}
