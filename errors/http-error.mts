export default class HttpError extends Error {
	public readonly status: number;
	public readonly body: unknown;

	public constructor(message: string, status: number, body: unknown) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.body = body;
	}
}
