export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const RUN_STAGES = ["validate", "forecast", "recommend", "explain"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunStage = (typeof RUN_STAGES)[number] | null;

export type RunSnapshot = Readonly<{
  projectId: string;
  runId: string;
  stateVersion: number;
  status: RunStatus;
  stage: RunStage;
}>;
export type RunUpdatedEvent = Readonly<{
  type: "run.updated";
  projectId: string;
  runId: string;
  stateVersion: number;
  status: RunStatus;
  stage: RunStage;
  emittedAt: string;
}>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROOM = /^project:([A-Za-z0-9_-]{1,64}):run:([A-Za-z0-9_-]{1,64})$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

export function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
export function roomId(projectId: string, runId: string): string {
  if (!validId(projectId) || !validId(runId)) throw new Error("INVALID_ROOM_ID");
  return `project:${projectId}:run:${runId}`;
}
export function parseRoom(value: unknown): { projectId: string; runId: string; room: string } | null {
  if (typeof value !== "string" || value.length > 141) return null;
  const matched = ROOM.exec(value);
  return matched ? { projectId: matched[1], runId: matched[2], room: value } : null;
}
export function parseAuthBody(value: unknown): { projectId: string; runId: string; room: string } | null {
  return isRecord(value) && exactKeys(value, ["room"]) ? parseRoom(value.room) : null;
}

export function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
export function validSnapshot(value: unknown): value is RunSnapshot {
  if (!isRecord(value)) return false;
  return validId(value.projectId) && validId(value.runId) &&
    Number.isSafeInteger(value.stateVersion) && (value.stateVersion as number) >= 0 &&
    RUN_STATUSES.includes(value.status as RunStatus) &&
    (value.stage === null || RUN_STAGES.includes(value.stage as (typeof RUN_STAGES)[number]));
}
export function validEvent(value: unknown): value is RunUpdatedEvent {
  if (!isRecord(value) || !exactKeys(value, ["type", "projectId", "runId", "stateVersion", "status", "stage", "emittedAt"])) return false;
  const emittedAt = value.emittedAt;
  return value.type === "run.updated" && validSnapshot(value) &&
    typeof emittedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(emittedAt) &&
    !Number.isNaN(Date.parse(emittedAt));
}

export function eventFromSnapshot(snapshot: RunSnapshot, now = new Date()): RunUpdatedEvent {
  if (!validSnapshot(snapshot)) throw new Error("INVALID_RUN_SNAPSHOT");
  return { type: "run.updated", projectId: snapshot.projectId, runId: snapshot.runId,
    stateVersion: snapshot.stateVersion, status: snapshot.status, stage: snapshot.stage,
    emittedAt: now.toISOString() };
}

export function stageName(stage: Exclude<RunStage, null>): string {
  return { validate: "Проверка данных", forecast: "Прогноз спроса", recommend: "Расчёт рекомендаций", explain: "Объяснение рекомендаций" }[stage];
}
