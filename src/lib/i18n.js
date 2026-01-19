const translations = {
	en: {
		appName: 'Righter',
		wpm: 'WPM',
		accuracy: 'Accuracy',
		time: 'Time',
		texts: 'Texts',
		characters: 'Chars',
		startTyping: 'Start typing...',
		newText: 'New Text',
		reset: 'Reset',
		settings: 'Settings',
		history: 'History',
		export: 'Export',
		import: 'Import',
		loadText: 'Load Text',
		clearTexts: 'Clear',
		language: 'Language',
		fontSize: 'Font Size',
		hue: 'Hue',
		customText: 'Custom Text',
		difficulty: 'Difficulty',
		easy: 'Easy',
		medium: 'Medium',
		hard: 'Hard',
		expert: 'Expert',
		noHistory: 'No races yet',
		raceComplete: 'Race complete!',
		pressEnter: 'Press Enter for next',
		date: 'Date',
		close: 'Close',
		persian: 'Persian',
		english: 'English'
	},
	fa: {
		appName: 'رایتر',
		wpm: 'کلمه/دقیقه',
		accuracy: 'دقت',
		time: 'زمان',
		texts: 'متن',
		characters: 'نویسه',
		startTyping: 'شروع به تایپ کنید...',
		newText: 'متن جدید',
		reset: 'از نو',
		settings: 'تنظیمات',
		history: 'تاریخچه',
		export: 'خروجی',
		import: 'ورودی',
		loadText: 'بارگذاری متن',
		clearTexts: 'پاک کردن',
		language: 'زبان',
		fontSize: 'اندازه قلم',
		hue: 'فام',
		customText: 'متن دلخواه',
		difficulty: 'سختی',
		easy: 'آسان',
		medium: 'متوسط',
		hard: 'دشوار',
		expert: 'حرفه‌ای',
		noHistory: 'هنوز مسابقه‌ای ثبت نشده',
		raceComplete: 'پایان!',
		pressEnter: 'برای ادامه Enter بزنید',
		date: 'تاریخ',
		close: 'بستن',
		persian: 'فارسی',
		english: 'انگلیسی'
	},
	es: {
		appName: 'Righter',
		wpm: 'PPM',
		accuracy: 'Precisión',
		time: 'Tiempo',
		texts: 'Textos',
		characters: 'Caract.',
		startTyping: 'Empieza a escribir...',
		newText: 'Nuevo texto',
		reset: 'Reiniciar',
		settings: 'Ajustes',
		history: 'Historial',
		export: 'Exportar',
		import: 'Importar',
		loadText: 'Cargar texto',
		clearTexts: 'Borrar',
		language: 'Idioma',
		fontSize: 'Tamaño',
		hue: 'Tono',
		customText: 'Texto personalizado',
		difficulty: 'Dificultad',
		easy: 'Fácil',
		medium: 'Medio',
		hard: 'Difícil',
		expert: 'Experto',
		noHistory: 'Sin carreras aún',
		raceComplete: 'Completado!',
		pressEnter: 'Pulsa Enter para continuar',
		date: 'Fecha',
		close: 'Cerrar',
		persian: 'Persa',
		english: 'Inglés'
	},
	de: {
		appName: 'Righter',
		wpm: 'WPM',
		accuracy: 'Genauigkeit',
		time: 'Zeit',
		texts: 'Texte',
		characters: 'Zeichen',
		startTyping: 'Tippen beginnen...',
		newText: 'Neuer Text',
		reset: 'Zurücksetzen',
		settings: 'Einstellungen',
		history: 'Verlauf',
		export: 'Exportieren',
		import: 'Importieren',
		loadText: 'Text laden',
		clearTexts: 'Löschen',
		language: 'Sprache',
		fontSize: 'Schriftgröße',
		hue: 'Farbton',
		customText: 'Eigener Text',
		difficulty: 'Schwierigkeit',
		easy: 'Leicht',
		medium: 'Mittel',
		hard: 'Schwer',
		expert: 'Experte',
		noHistory: 'Noch keine Rennen',
		raceComplete: 'Fertig!',
		pressEnter: 'Enter für weiter',
		date: 'Datum',
		close: 'Schließen',
		persian: 'Persisch',
		english: 'Englisch'
	}
};

export function getTranslation(lang, key) {
	return translations[lang]?.[key] ?? translations.en[key] ?? key;
}

export function t(lang) {
	return (key) => getTranslation(lang, key);
}

export function detectLanguage() {
	if (typeof navigator === 'undefined') return 'en';
	const browserLang = navigator.language?.split('-')[0];
	return browserLang === 'fa' ? 'fa' : 'en';
}

export function getDirection(lang) {
	return lang === 'fa' ? 'rtl' : 'ltr';
}

export const supportedLanguages = [
	{ code: 'en', name: 'English', nativeName: 'English' },
	{ code: 'de', name: 'German', nativeName: 'Deutsch' },
	{ code: 'es', name: 'Spanish', nativeName: 'Español' },
	{ code: 'fa', name: 'Persian', nativeName: 'فارسی' }
];
