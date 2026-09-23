import "server-only";
import { Liveblocks, type RoomData } from "@liveblocks/node";
import { roomId } from "./contracts";

export type RoomProvisionPort = Pick<Liveblocks, "getOrCreateRoom">;
export type LiveblocksRoomPort = RoomProvisionPort & Pick<Liveblocks, "broadcastEvent" | "setPresence">;

export function liveblocksServerFromEnv(): Liveblocks | null {
  const secret = process.env.LIVEBLOCKS_SECRET_KEY?.trim();
  return secret?.startsWith("sk_") ? new Liveblocks({ secret }) : null;
}

function privateRoom(data: RoomData): boolean {
  return Array.isArray(data.defaultAccesses) && data.defaultAccesses.length === 0 &&
    Object.keys(data.usersAccesses).length === 0 && Object.keys(data.groupsAccesses).length === 0;
}

export async function ensurePrivateRunRoom(
  client: RoomProvisionPort, projectId: string, runId: string, signal?: AbortSignal,
): Promise<string> {
  const room = roomId(projectId, runId);
  const existing = await client.getOrCreateRoom(room, { defaultAccesses: [] }, { signal });
  if (existing.id !== room || !privateRoom(existing)) throw new Error("ROOM_NOT_PRIVATE");
  return room;
}
