import { api } from "./api.js";

export interface LiveHandlers {
  onChange(): void;
  onState(connected: boolean): void;
  onNotice(text: string): void;
}

let source: EventSource | null = null;
let retry: number | undefined;

export function stopLive(): void {
  clearTimeout(retry);
  source?.close();
  source = null;
}

/** Opens the server's /live stream. Reconnects on its own; tells the caller when the session has ended. */
export function startLive(h: LiveHandlers): void {
  if (typeof EventSource === "undefined") return;
  stopLive();
  let wasDown = false;
  const connect = (): void => {
    const es = new EventSource("/live");
    source = es;
    es.addEventListener("hello", () => { h.onState(true); if (wasDown) h.onChange(); wasDown = false; }); // catch up after a gap
    es.addEventListener("change", () => h.onChange());
    es.addEventListener("notice", (e) => { try { h.onNotice(JSON.parse((e as MessageEvent).data).text); } catch { /* ignore a malformed notice */ } });
    es.onerror = () => {
      h.onState(false);
      wasDown = true;
      if (es.readyState !== EventSource.CLOSED) return; // the browser is retrying by itself
      es.close();
      retry = window.setTimeout(() => {
        api("GET", "/auth/status").then((s) => { if (s.authenticated) connect(); else dispatchEvent(new Event("nn:unauthorized")); }, () => connect());
      }, 4000);
    };
  };
  connect();
}
