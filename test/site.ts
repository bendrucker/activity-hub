// The service binding names a Worker in another repo, and Miniflare refuses to
// start with a binding that resolves to nothing. Tests reach the publish
// surface through the options bag instead, so this only has to exist and carry
// the entrypoint's name.

export const SITE_WORKER = "bendrucker-me";

export const SITE_STUB = `
import { WorkerEntrypoint } from "cloudflare:workers";

export class Publish extends WorkerEntrypoint {
  async publishActivity() {}
  async publishPowerCurve() {}
  async deleteActivity() {}
}

export default {
  fetch() {
    return new Response("site stub");
  },
};
`;
