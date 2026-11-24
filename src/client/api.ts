/** The board's REST API at `/api/board`. The session cookie says who writes. */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const BOARD_API = "/api/board";

const call = async <A>(
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<A> => {
  const response = await fetch(
    path.startsWith("/api/") ? path : `${BOARD_API}${path}`,
    {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method,
    }
  );
  const text = await response.text();
  const json = (text === "" ? {} : JSON.parse(text)) as A & {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new ApiError(
      json.error?.code ?? "error",
      json.error?.message ?? `HTTP ${response.status}`,
      response.status
    );
  }
  return json;
};

/** A GET with query parameters; undefined values are left out. */
export const get = <A>(
  path: string,
  query: Record<string, string | number | boolean | undefined> = {}
) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return call<A>("GET", search === "" ? path : `${path}?${search}`);
};

export const post = <A = unknown>(path: string, body?: unknown) =>
  call<A>("POST", path, body ?? {});

/** The most one upload takes: a bigger file needs a direct upload, which a `local()` board has not. */
export const UPLOAD_BYTES_MAX = 4 * 1024 * 1024;

/** Uploads one file: the body is the file. A post then names it by its ID. */
export const upload = async (file: File) => {
  const response = await fetch(`${BOARD_API}/attachments`, {
    body: file,
    credentials: "same-origin",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-board-filename": encodeURIComponent(file.name),
    },
    method: "POST",
  });
  const json = (await response.json()) as {
    attachment?: { id: string };
    error?: { code?: string; message?: string };
  };
  if (!(response.ok && json.attachment)) {
    throw new ApiError(
      json.error?.code ?? "error",
      json.error?.message ?? `HTTP ${response.status}`,
      response.status
    );
  }
  return json.attachment.id;
};
