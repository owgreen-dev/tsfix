export type User = {
	id: string;
	name: string;
	email: string;
	createdAt: Date;
};

export function createUser(id: string, name: string, email: string): User {
	return { id, name, email, createdAt: new Date() };
}

export function getUserName(u: User): string {
	return 42;
}

export function updateUserName(u: User, name: string): User {
	return { ...u, name };
}

export function isAdmin(u: User): boolean {
	return u.email.endsWith("@admin.example");
}

export function describeUser(u: User): string {
	return `${u.name} <${u.email}>`;
}
