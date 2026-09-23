import "server-only";
import { eventFromSnapshot, isTerminal, stageName, validSnapshot, type RunSnapshot } from "./contracts";
import { ensurePrivateRunRoom, type LiveblocksRoomPort } from "./server";

export type PublishResult = Readonly<{ published: boolean; presence: boolean; errorCode?: "INVALID_SNAPSHOT" | "REALTIME_UNAVAILABLE" }>;
const TTL_SECONDS = 60;
const DEADLINE_MS = 5_000;

// Call only after the stateVersion transaction commits. This function never
// changes a business row and never retries a potentially delivered event.
export async function publishCommittedRunStatus(
  snapshot: RunSnapshot, client: LiveblocksRoomPort | null, options: { signal?: AbortSignal; now?: Date } = {},
): Promise<PublishResult> {
  if (!validSnapshot(snapshot)) return { published: false, presence: false, errorCode: "INVALID_SNAPSHOT" };
  if (!client) return { published: false, presence: false, errorCode: "REALTIME_UNAVAILABLE" };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const aborted = new Promise<never>((_, reject) => {
    if (controller.signal.aborted) reject(new Error("ABORTED"));
    else controller.signal.addEventListener("abort", () => reject(new Error("ABORTED")), { once: true });
  });
  let published = false;
  try {
    const room = await Promise.race([ensurePrivateRunRoom(client, snapshot.projectId, snapshot.runId, controller.signal), aborted]);
    await Promise.race([client.broadcastEvent(room, eventFromSnapshot(snapshot, options.now), { signal: controller.signal }), aborted]);
    published = true;
    if (snapshot.status !== "running" || !snapshot.stage || isTerminal(snapshot.status)) return { published: true, presence: false };
    try {
      await Promise.race([client.setPresence(room, { userId: `agent:${snapshot.runId}:${snapshot.stage}`,
        data: { runId: snapshot.runId, stage: snapshot.stage, status: snapshot.status },
        userInfo: { name: stageName(snapshot.stage) }, ttl: TTL_SECONDS }, { signal: controller.signal }), aborted]);
      return { published: true, presence: true };
    } catch { return { published: true, presence: false, errorCode: "REALTIME_UNAVAILABLE" }; }
  } catch { return { published, presence: false, errorCode: "REALTIME_UNAVAILABLE" }; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}
