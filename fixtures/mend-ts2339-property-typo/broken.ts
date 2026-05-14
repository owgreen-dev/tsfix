type User = {
	id: string;
	name: string;
};

export function getEmail(u: User): string {
	return u.email;
}
