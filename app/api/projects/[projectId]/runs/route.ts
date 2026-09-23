import { runsHandlers } from "@/lib/server/runs-runtime";

export const runtime = "nodejs";
export const GET = runsHandlers.list;
export const POST = runsHandlers.create;
