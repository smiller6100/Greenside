import { useEffect, useRef, useState, useCallback } from "react";
import type { RoundState } from "./golf";

export function useRound(code: string) {
  const [state, setState] = useState<RoundState | null>(null);
  const [connected, setConnected] = useState(false);
  const [missing, setMissing] = useState(false);
  const [positions, setPositions] = useState<Record<string, { lat: number; lng: number; acc?: number; ts: number }>>({});
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;

    // Try the current host first; if the socket can't connect (e.g. the custom domain
    // is briefly not carrying WebSockets after a deploy), fall back to the worker's
    // always-on address so the round never hangs on "Connecting…".
    const FALLBACK_HOST = "greenside.smiller6100.workers.dev";
    const hosts = location.host === FALLBACK_HOST ? [location.host] : [location.host, FALLBACK_HOST];
    let hostIdx = 0;
    let fails = 0;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${hosts[hostIdx]}/api/round/${code}/connect`);
      wsRef.current = sock;
      sock.onopen = () => { if (alive) { fails = 0; setConnected(true); } };
      sock.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.type === "state") setState(d.state);
          else if (d.type === "pos") setPositions((p) => ({ ...p, [d.id]: { lat: d.lat, lng: d.lng, acc: d.acc, ts: Date.now() } }));
          else if (d.type === "posClear") setPositions((p) => { const n = { ...p }; delete n[d.id]; return n; });
          else if (d.type === "chatMsg") setState((s) => s ? { ...s, chat: [...((s.chat as any) || []), d.msg].slice(-80) } : s);
        } catch { /* ignore */ }
      };
      sock.onclose = (e) => {
        if (!alive) return;
        setConnected(false);
        if (e.code === 4404) { setMissing(true); return; }
        fails++;
        if (fails >= 3 && hosts.length > 1) { hostIdx = (hostIdx + 1) % hosts.length; fails = 0; } // switch hosts
        retry = setTimeout(connect, 1200);
      };
      sock.onerror = () => { try { sock.close(); } catch { /* */ } };
    };

    // verify the round exists before opening a socket
    fetch(`/api/round/${code}`).then((r) => {
      if (!alive) return;
      if (r.status === 404) { setMissing(true); return; }
      connect();
    }).catch(() => { if (alive) connect(); });

    return () => { alive = false; clearTimeout(retry); wsRef.current?.close(); };
  }, [code]);

  const sendScore = useCallback((playerId: string, hole: number, strokes: number) => {
    wsRef.current?.send(JSON.stringify({ type: "score", playerId, hole, strokes }));
    // optimistic local update for a snappy stepper
    setState((s) => s ? {
      ...s,
      scores: { ...s.scores, [playerId]: { ...(s.scores[playerId] || {}), [hole]: strokes } },
    } : s);
  }, []);

  const sendWolfPick = useCallback((hole: number, partner: string | null) => {
    wsRef.current?.send(JSON.stringify({ type: "wolfPick", hole, partner }));
    setState((s) => {
      if (!s) return s;
      const wolf = { ...(s.wolf || {}) };
      if (partner === null) delete wolf[hole]; else wolf[hole] = partner;
      return { ...s, wolf };
    });
  }, []);

  const sendBbb = useCallback((hole: number, which: "bingo" | "bango" | "bongo", player: string | null) => {
    wsRef.current?.send(JSON.stringify({ type: "bbbPick", hole, which, player }));
    setState((s) => {
      if (!s) return s;
      const bbb = { ...(s.bbb || {}) };
      const cur = { ...(bbb[hole] || {}) };
      if (player === null) delete cur[which]; else cur[which] = player;
      bbb[hole] = cur;
      return { ...s, bbb };
    });
  }, []);

  const sendPress = useCallback((game: "sixes" | "nassau", hole: number) => {
    wsRef.current?.send(JSON.stringify({ type: "press", game, hole }));
    setState((s) => {
      if (!s) return s;
      const presses: any = { ...(s.presses || {}) };
      const arr = [...(presses[game] || [])];
      const i = arr.indexOf(hole);
      if (i >= 0) arr.splice(i, 1); else arr.push(hole);
      presses[game] = arr;
      return { ...s, presses };
    });
  }, []);

  const sendSixesMode = useCallback((mode: "points" | "skins") => {
    wsRef.current?.send(JSON.stringify({ type: "setMode", game: "sixes", mode }));
    setState((s) => (s ? { ...s, sixesMode: mode } : s));
  }, []);

  const sendAddPlayer = useCallback((player: { id: string; name: string; hcp: number; group?: string }) => {
    wsRef.current?.send(JSON.stringify({ type: "addPlayer", ...player }));
    setState((s) => (s && !s.players.some((p) => p.id === player.id)
      ? { ...s, players: [...s.players, player as any] } : s));
  }, []);

  const sendTeamScore = useCallback((group: string, hole: number, strokes: number) => {
    wsRef.current?.send(JSON.stringify({ type: "teamScore", group, hole, strokes }));
    setState((s) => s ? {
      ...s,
      teamScores: { ...(s.teamScores || {}), [group]: { ...((s.teamScores || {})[group] || {}), [hole]: strokes } },
    } : s);
  }, []);

  const sendTeamMode = useCallback((token: string, mode: "bestball" | "best2" | "scramble") => {
    wsRef.current?.send(JSON.stringify({ type: "setTeamMode", token, mode }));
    setState((s) => (s ? { ...s, teamMode: mode } : s));
  }, []);

  const sendDeleteGroup = useCallback((token: string, group: string) => {
    wsRef.current?.send(JSON.stringify({ type: "deleteGroup", token, group }));
  }, []);
  const sendRemovePlayer = useCallback((token: string, id: string) => {
    wsRef.current?.send(JSON.stringify({ type: "removePlayer", token, id }));
  }, []);
  const sendSetRules = useCallback((token: string, rules: { handicapMode?: string; formats?: Record<string, boolean>; games?: Record<string, boolean> }) => {
    wsRef.current?.send(JSON.stringify({ type: "setRules", token, ...rules }));
    setState((s) => (s && rules.handicapMode ? { ...s, handicapMode: rules.handicapMode as any } : s));
  }, []);

  const sendPos = useCallback((id: string, lat: number, lng: number, acc?: number) => {
    wsRef.current?.send(JSON.stringify({ type: "pos", id, lat, lng, acc }));
  }, []);
  const sendPosClear = useCallback((id: string) => {
    wsRef.current?.send(JSON.stringify({ type: "posClear", id }));
  }, []);
  const sendChat = useCallback((name: string, text: string) => {
    wsRef.current?.send(JSON.stringify({ type: "chat", name, text }));
  }, []);

  return { state, connected, missing, positions, sendScore, sendWolfPick, sendBbb, sendPress, sendSixesMode, sendAddPlayer, sendTeamScore, sendTeamMode, sendDeleteGroup, sendRemovePlayer, sendSetRules, sendPos, sendPosClear, sendChat };
}
