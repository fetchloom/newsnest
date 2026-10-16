/** An error that is safe to show to API clients. */
export class ApiError extends Error {
  status: number;
  code: string;
  headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const validation = (message: string): ApiError => new ApiError(422, "validation_error", message);
export const notFound = (what: string): ApiError => new ApiError(404, "not_found", `${what} not found`);
