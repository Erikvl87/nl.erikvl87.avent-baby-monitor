export interface FakeFetchCall {
	url: string;
	init: RequestInit | undefined;
}

export interface FakeResponseInit {
	status?: number;
	body?: unknown;
	bodyText?: string;
}

/**
 * Builds a `Response`-like object that matches the subset of the Fetch API the
 * `UpstairsClient` uses: `ok`, `status`, `json()`, `text()`, and `clone()`.
 *
 * @param init - Response configuration; `body` is JSON-serialized unless `bodyText` is given
 */
export function buildFakeResponse(init: FakeResponseInit = {}): Response {
	const status = init.status ?? 200;
	const bodyText = init.bodyText ?? (init.body !== undefined ? JSON.stringify(init.body) : '');

	const response = {
		ok: status >= 200 && status < 300,
		status,
		json: async () => (bodyText ? JSON.parse(bodyText) : undefined),
		text: async () => bodyText,
		clone: () => response,
	} as unknown as Response;

	return response;
}

export interface FakeFetch {
	(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	calls: FakeFetchCall[];
}

/**
 * Builds a `fetch`-compatible stub that returns the provided responses in
 * order. Each call is recorded in `calls` for URL/body assertions.
 *
 * @param responses - Responses to return per call (or functions producing one)
 */
export function createFakeFetch(
	responses: Array<Response | ((call: FakeFetchCall) => Response | Promise<Response>)>,
): FakeFetch {
	const calls: FakeFetchCall[] = [];
	let index = 0;

	const fake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input.toString();
		const call: FakeFetchCall = { url, init };
		calls.push(call);

		const next = responses[index++];
		if (!next) {
			throw new Error(`fake fetch received unexpected call #${index} to ${url}`);
		}
		return typeof next === 'function' ? await next(call) : next;
	}) as FakeFetch;

	fake.calls = calls;
	return fake;
}
