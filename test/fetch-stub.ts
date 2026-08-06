export interface FetchStub {
  fetch: typeof globalThis.fetch;
  requests: Request[];
}

export function stubFetch(
  respond: (request: Request) => Response | Promise<Response>,
): FetchStub {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  };
  return { fetch, requests };
}
