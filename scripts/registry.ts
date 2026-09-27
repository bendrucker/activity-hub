// The production registry, reached through the pinned wrangler binary.
const DATABASE = "activity-hub-registry";

export function query(sql: string): Record<string, unknown>[] {
  const stdout = wrangler(["d1", "execute", DATABASE, "--remote", "--json", "--command", sql]);
  const parsed = JSON.parse(stdout) as { results: Record<string, unknown>[] }[];
  const first = parsed[0];
  if (!first) {
    throw new Error(`no result from d1 execute: ${stdout.slice(0, 200)}`);
  }
  return first.results;
}

export function executeFile(sqlPath: string): void {
  wrangler(["d1", "execute", DATABASE, "--remote", "--yes", "--file", sqlPath]);
}

export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function wrangler(args: string[]): string {
  const result = Bun.spawnSync(["bun", "run", "--silent", "wrangler", "--", ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.exitCode !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed (${result.exitCode})`);
  }
  return result.stdout.toString();
}
