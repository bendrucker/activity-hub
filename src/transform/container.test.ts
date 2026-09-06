import { describe, expect, it } from "vitest";
import { acceptedLakeBuild } from "./container";

function lakeRequest(): Request {
  return new Request("http://container/lake", { method: "POST" });
}

describe("acceptedLakeBuild", () => {
  it("recognizes an accepted build", () => {
    expect(acceptedLakeBuild(lakeRequest(), new Response(null, { status: 202 }))).toBe(true);
  });

  // A busy answer means a build is already running and already holds the
  // deadline. Extending again on the refusal would stack a fresh 90 minutes
  // onto every retry.
  it("does not count a build refused as busy", () => {
    expect(acceptedLakeBuild(lakeRequest(), new Response(null, { status: 409 }))).toBe(false);
  });

  it("does not count other routes", () => {
    const decode = new Request("http://container/decode", { method: "POST" });
    expect(acceptedLakeBuild(decode, new Response(null, { status: 202 }))).toBe(false);
  });
});
