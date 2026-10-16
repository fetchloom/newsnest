export class ApiFail extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Calls the Freepost API with the dashboard session cookie. */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-freepost": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFail(0, "network", "Can't reach the server. Is Freepost still running?");
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) dispatchEvent(new Event("fp:unauthorized"));
    throw new ApiFail(res.status, json?.name ?? "error", json?.message ?? `Request failed (${res.status})`);
  }
  return json as T;
}
