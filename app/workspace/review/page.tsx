import Link from "next/link";
import { isClerkConfigured, requireUserId } from "@/lib/server/auth";
import { getPool } from "@/lib/server/db/pool";
export default async function ReviewRunsPage() {
  if (!isClerkConfigured()) return <main className="p-6">Для проверки сохранённых расчётов настройте авторизацию.</main>;
  const userId = await requireUserId();
  let rows: {id: string; name: string}[];
  try {
    rows = (await getPool().query<{id: string; name: string}>(`SELECT r.id,p.name FROM calculation_runs r JOIN projects p ON p.id=r.project_id WHERE p.owner_user_id=$1 AND p.archived_at IS NULL AND r.status='succeeded' ORDER BY r.created_at DESC LIMIT 100`,[userId])).rows;
  } catch { return <main className="p-6" role="alert">Не удалось загрузить расчёты. Повторите попытку позже.</main>; }
  return <main className="space-y-4 p-6"><h1 className="text-2xl font-semibold">Проверка сохранённых расчётов</h1>{rows.length ? <ul>{rows.map(row => <li key={row.id}><Link className="underline" href={`/workspace?runId=${row.id}`}>{row.name} · {row.id}</Link></li>)}</ul> : <p>Успешных расчётов пока нет.</p>}<Link href="/workspace">Рабочее место</Link></main>;
}
