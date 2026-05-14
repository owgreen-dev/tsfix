type User = {
	id: string;
	name: string;
	email: string;
};

export function newUser(): User {
	return { id: "1", name: "Alice" };
}
