export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ContainerConfig {
  accountId: string;
  raw: Credentials;
  lake: Credentials;
}

const ACCOUNT_ID = "R2_ACCOUNT_ID";
const RAW_ACCESS_KEY_ID = "R2_RAW_ACCESS_KEY_ID";
const RAW_SECRET_ACCESS_KEY = "R2_RAW_SECRET_ACCESS_KEY";
const LAKE_ACCESS_KEY_ID = "R2_LAKE_ACCESS_KEY_ID";
const LAKE_SECRET_ACCESS_KEY = "R2_LAKE_SECRET_ACCESS_KEY";

// Reports every missing name at once. A container that starts without
// credentials fails every batch it is handed, so this runs before the listener
// opens and the process exits rather than serving.
export function readConfig(
  env: Record<string, string | undefined>,
): ContainerConfig {
  const missing = [
    ACCOUNT_ID,
    RAW_ACCESS_KEY_ID,
    RAW_SECRET_ACCESS_KEY,
    LAKE_ACCESS_KEY_ID,
    LAKE_SECRET_ACCESS_KEY,
  ].filter((name) => !env[name]);

  if (missing.length > 0) {
    throw new Error(`missing container environment: ${missing.join(", ")}`);
  }

  return {
    accountId: required(env, ACCOUNT_ID),
    raw: {
      accessKeyId: required(env, RAW_ACCESS_KEY_ID),
      secretAccessKey: required(env, RAW_SECRET_ACCESS_KEY),
    },
    lake: {
      accessKeyId: required(env, LAKE_ACCESS_KEY_ID),
      secretAccessKey: required(env, LAKE_SECRET_ACCESS_KEY),
    },
  };
}

export function endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`missing container environment: ${name}`);
  }
  return value;
}
