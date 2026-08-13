import { expect, test } from "bun:test";
import { endpoint, readConfig } from "./env";

const COMPLETE = {
  R2_ACCOUNT_ID: "acct",
  R2_RAW_ACCESS_KEY_ID: "raw-key",
  R2_RAW_SECRET_ACCESS_KEY: "raw-secret",
  R2_LAKE_ACCESS_KEY_ID: "lake-key",
  R2_LAKE_SECRET_ACCESS_KEY: "lake-secret",
};

test("reads both credential pairs", () => {
  expect(readConfig(COMPLETE)).toEqual({
    accountId: "acct",
    raw: { accessKeyId: "raw-key", secretAccessKey: "raw-secret" },
    lake: { accessKeyId: "lake-key", secretAccessKey: "lake-secret" },
  });
});

test("names every missing variable at once", () => {
  expect(() =>
    readConfig({ R2_ACCOUNT_ID: "acct", R2_RAW_ACCESS_KEY_ID: "raw-key" }),
  ).toThrow(
    "missing container environment: R2_RAW_SECRET_ACCESS_KEY, R2_LAKE_ACCESS_KEY_ID, R2_LAKE_SECRET_ACCESS_KEY",
  );
});

test("treats an empty value as missing", () => {
  expect(() =>
    readConfig({ ...COMPLETE, R2_LAKE_SECRET_ACCESS_KEY: "" }),
  ).toThrow("R2_LAKE_SECRET_ACCESS_KEY");
});

test("builds the account's S3 endpoint", () => {
  expect(endpoint("acct")).toBe("https://acct.r2.cloudflarestorage.com");
});
