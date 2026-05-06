import { describe, expect, it, vi } from "vitest";
import { withRetry } from "./retry.js";

describe("withRetry", () => {
  it("retries transient failures until an attempt succeeds", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn(async () => undefined);

    await expect(
      withRetry(operation, {
        attempts: 3,
        baseDelayMs: 10,
        sleep,
        shouldRetry: () => true,
      }),
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("does not retry errors rejected by the retry predicate", async () => {
    const error = new Error("permanent");
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    const sleep = vi.fn(async () => undefined);

    await expect(
      withRetry(operation, {
        attempts: 3,
        sleep,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow("permanent");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses capped exponential delays", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("temporary"));
    const sleep = vi.fn(async () => undefined);

    await expect(
      withRetry(operation, {
        attempts: 3,
        baseDelayMs: 50,
        maxDelayMs: 75,
        sleep,
        shouldRetry: () => true,
      }),
    ).rejects.toThrow("temporary");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 50);
    expect(sleep).toHaveBeenNthCalledWith(2, 75);
  });
});
