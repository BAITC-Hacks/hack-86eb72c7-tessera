"use client";

import { LiveblocksProvider, RoomProvider, useEventListener, useStatus } from "@liveblocks/react";
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { parseRoom, roomId } from "@/lib/realtime/contracts";

type RoomSignals = Readonly<{
  connected: boolean;
  subscribe: (listener: (event: unknown) => void) => () => void;
}>;
const RunRoomContext = createContext<RoomSignals | null>(null);

function RoomBridge({ children }: { children: ReactNode }) {
  const status = useStatus();
  const listeners = useRef(new Set<(event: unknown) => void>());
  useEventListener(({ event }) => { for (const listener of listeners.current) listener(event); });
  const value = useMemo<RoomSignals>(() => ({
    connected: status === "connected",
    subscribe(listener) {
      listeners.current.add(listener);
      return () => { listeners.current.delete(listener); };
    },
  }), [status]);
  return <RunRoomContext.Provider value={value}>{children}</RunRoomContext.Provider>;
}

export function RunRoomProvider({ projectId, runId, enabled = false, children }: {
  projectId: string; runId: string; enabled?: boolean; children: ReactNode;
}) {
  let room: string;
  try { room = roomId(projectId, runId); }
  catch { return <>{children}</>; }
  if (!enabled || !parseRoom(room)) return <>{children}</>;
  return (
    <LiveblocksProvider authEndpoint="/api/liveblocks-auth">
      <RoomProvider key={room} id={room} initialPresence={{}}>
        <RoomBridge>{children}</RoomBridge>
      </RoomProvider>
    </LiveblocksProvider>
  );
}

export function useRunRoomSignals(): RoomSignals | null { return useContext(RunRoomContext); }
