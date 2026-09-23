import Link from "next/link";
import { connection } from "next/server";
import { AuthConfigurationError, UnauthenticatedError, isClerkConfigured, requireUserId } from "@/lib/server/auth";
import { getPool } from "@/lib/server/db/pool";
export default async function ReviewRunsPage() {
  await connection();
  if (!isClerkConfigured()) return <main className="p-6">Для проверки сохранённых расчётов настройте авторизацию.</main>;
  let userId: string;
  try { userId = await requireUserId(); }
  catch (error) {
    if (error instanceof AuthConfigurationError) return <main className="p-6">Авторизация временно недоступна.</main>;
    if (error instanceof UnauthenticatedError) return <main className="p-6"><h1 className="text-2xl font-semibold">Проверка сохранённых расчётов</h1><p className="mt-3 text-sm">Чтобы увидеть свои расчёты, войдите в систему.</p><Link href="/sign-in" className="mt-4 inline-block text-sm underline underline-offset-4">Войти</Link></main>;
    throw error;
  }
  let rows: {id: string; name: string}[];
  try {
    rows = (await getPool().query<{id: string; name: string}>(`SELECT r.id,p.name FROM calculation_runs r JOIN projects p ON p.id=r.project_id WHERE p.owner_user_id=$1 AND p.archived_at IS NULL AND r.status='succeeded' ORDER BY r.created_at DESC LIMIT 100`,[userId])).rows;
  } catch { return <main className="p-6" role="alert">Не удалось загрузить расчёты. Повторите попытку позже.</main>; }
  return <main className="space-y-4 p-6"><h1 className="text-2xl font-semibold">Проверка сохранённых расчётов</h1>{rows.length ? <ul>{rows.map(row => <li key={row.id}><Link className="underline" href={`/workspace?runId=${row.id}`}>{row.name} · {row.id}</Link></li>)}</ul> : <p>Успешных расчётов пока нет.</p>}<Link href="/workspace">Рабочее место</Link></main>;
}
