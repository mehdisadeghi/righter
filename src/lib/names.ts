const adjectives = [
	'Swift', 'Blue', 'Red', 'Golden', 'Silver', 'Brave', 'Calm', 'Clever',
	'Bright', 'Wild', 'Gentle', 'Bold', 'Quick', 'Silent', 'Fierce', 'Noble',
	'Cosmic', 'Lucky', 'Mystic', 'Nimble', 'Radiant', 'Serene', 'Vivid', 'Zen'
];

const animals = [
	'Turtle', 'Rabbit', 'Fox', 'Owl', 'Wolf', 'Bear', 'Hawk', 'Tiger',
	'Panda', 'Eagle', 'Dolphin', 'Lion', 'Falcon', 'Raven', 'Phoenix', 'Dragon',
	'Lynx', 'Otter', 'Crane', 'Jaguar', 'Cobra', 'Mantis', 'Shark', 'Panther'
];

const adjectivesFa = [
	'تند', 'آبی', 'سرخ', 'طلایی', 'نقره‌ای', 'دلیر', 'آرام', 'زیرک',
	'درخشان', 'وحشی', 'مهربان', 'جسور', 'چابک', 'خاموش', 'سرسخت', 'نجیب'
];

const animalsFa = [
	'لاک‌پشت', 'خرگوش', 'روباه', 'جغد', 'گرگ', 'خرس', 'باز', 'ببر',
	'پاندا', 'عقاب', 'دلفین', 'شیر', 'شاهین', 'کلاغ', 'ققنوس', 'اژدها'
];

function randomFrom<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

export function generateName(rtl = false): string {
	if (rtl) {
		return `${randomFrom(animalsFa)} ${randomFrom(adjectivesFa)}`;
	}
	return `${randomFrom(adjectives)} ${randomFrom(animals)}`;
}

export function generateColor(): number {
	return Math.floor(Math.random() * 360);
}
