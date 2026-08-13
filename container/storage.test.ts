import { expect, test } from "bun:test";
import { s3Error } from "./storage";

test("prefixes the S3 error code onto the fixed message Bun supplies", () => {
  const raised = Object.assign(new Error("an unexpected error has occurred"), {
    name: "S3Error",
    code: "NoSuchKey",
    path: "strava/a.fit.gz",
  });

  const error = s3Error(raised);
  expect(error.message).toBe("NoSuchKey: an unexpected error has occurred");
  expect(error.cause).toBe(raised);
});

test("passes through an error that carries no code", () => {
  const raised = new Error("socket hang up");
  expect(s3Error(raised)).toBe(raised);
});

test("wraps a non-error rejection", () => {
  expect(s3Error("boom").message).toBe("boom");
});
