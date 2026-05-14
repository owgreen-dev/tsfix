export type Request = {
	url: string;
	method: string;
	body?: string;
	headers: Record<string, string>;
};

export type Response = {
	status: number;
	body: string;
	headers: Record<string, string>;
};

export function getHandler(req: Request): Response {
	return { status: 200, body: `GET ${req.url}`, headers: {} };
}

export function postHandler(req: Request): Response {
	if (!req.body) return { status: 400, body: "missing body", headers: {} };
	return { status: 201, body: req.xqz_doesNotExist0, headers: {} };
}

export function deleteHandler(req: Request, id: string): Response {
	return { status: 204, body: `deleted ${id}`, headers: {} };
}

export function notFound(req: Request): Response {
	return { status: 404, body: `not found: ${req.url}`, headers: {} };
}
