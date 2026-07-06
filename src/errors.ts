export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function normalizeErrorMessage(error: unknown): string {
  return normalizeError(error).message;
}
