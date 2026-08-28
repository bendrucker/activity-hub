import type {
  LakeBuildSummary,
  LakeRequest,
  LakeStart,
  LakeTableResult,
} from "../src/transform/protocol";

export interface LakeRunnerDeps {
  build(request: LakeRequest): Promise<{ tables: LakeTableResult[] }>;
  save(summary: LakeBuildSummary): Promise<void>;
  // Called once the running build settles after a drain, when the process is
  // finally free to honor the SIGTERM it deferred.
  exit(): void;
}

export interface LakeRunner {
  start(request: LakeRequest): LakeStart;
  // Returns whether exit is deferred: true means a build is running and exit()
  // fires when it settles, false means there is nothing to wait for.
  drain(): boolean;
}

// Owns the single in-flight build. One instance exists and it caps itself at
// one build, so an in-process boolean is the complete concurrency guard.
export function lakeRunner(deps: LakeRunnerDeps): LakeRunner {
  let running = false;
  let draining = false;

  async function run(request: LakeRequest, startedAt: string): Promise<void> {
    const outcome: Pick<LakeBuildSummary, "tables" | "error"> = {};
    try {
      outcome.tables = (await deps.build(request)).tables;
    } catch (error) {
      outcome.error = String(error);
      console.error(`lake build failed: ${outcome.error}`);
    }
    try {
      await deps.save({
        startedAt,
        finishedAt: new Date().toISOString(),
        ...outcome,
      });
    } catch (error) {
      console.error(`lake build summary write failed: ${String(error)}`);
    }
    running = false;
    if (draining) {
      deps.exit();
    }
  }

  return {
    start(request) {
      if (running) {
        return { accepted: false };
      }
      running = true;
      const startedAt = new Date().toISOString();
      void run(request, startedAt);
      return { accepted: true, startedAt };
    },
    drain() {
      if (!running) {
        return false;
      }
      draining = true;
      return true;
    },
  };
}
