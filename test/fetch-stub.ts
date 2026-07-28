export interface FetchStub {
  fetchImpl: typeof fetch;
  requests: Request[];
}

export function stubFetch(
  respond: (request: Request) => Response | Promise<Response>,
): FetchStub {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  };
  return { fetchImpl, requests };
}
