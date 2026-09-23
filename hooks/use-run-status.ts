"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRunRoomSignals } from "@/components/providers/run-room-provider";
import { RunStatusController, viewForRun, type FetchSnapshot, type StatusView } from "@/lib/realtime/status-controller";
import type { RunSnapshot } from "@/lib/realtime/contracts";

export function useRunStatus(initial: RunSnapshot, fetchSnapshot: FetchSnapshot) {
  const signals = useRunRoomSignals();
  const fetchRef = useRef(fetchSnapshot);
  const [view, setView] = useState<StatusView>({ snapshot: initial, lastConfirmedAt: 0, delayed: false, connected: false });
  const controllerRef = useRef<RunStatusController | null>(null);
  const key = `${initial.projectId}:${initial.runId}`;

  useEffect(() => { fetchRef.current = fetchSnapshot; }, [fetchSnapshot]);

  useEffect(() => {
    const controller = new RunStatusController(initial, (signal) => fetchRef.current(signal), setView);
    controllerRef.current = controller;
    setView(controller.current);
    controller.start();
    const onFocus = () => controller.focus();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  // Changing the active run creates a new controller; ordinary re-renders do not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { controllerRef.current?.setConnected(signals?.connected ?? false); }, [signals?.connected, key]);
  useEffect(() => signals?.subscribe((event) => controllerRef.current?.onEvent(event)), [signals]);
  const refresh = useCallback(() => {
    const controller = controllerRef.current;
    if (controller?.current.snapshot.projectId === initial.projectId && controller.current.snapshot.runId === initial.runId) controller.refresh();
  }, [initial.projectId, initial.runId]);
  return { ...viewForRun(view, initial, signals?.connected ?? false), refresh };
}
