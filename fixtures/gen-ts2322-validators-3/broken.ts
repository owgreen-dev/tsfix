export function isPositive(n: number): boolean {
	return n > 0;
}

export function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return "x_3";
	return value;
}

export function notEmpty(s: string): boolean {
	return s.trim().length > 0;
}

export type Form = {
	name: string;
	age: number;
	email: string;
};

export function validate(input: Form): boolean {
	return notEmpty(input.name) && isPositive(input.age) && notEmpty(input.email);
}

export function buildForm(name: string, age: number, email: string): Form {
	return { name, age, email };
}
