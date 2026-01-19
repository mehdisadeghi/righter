# Righter

A minimalist touch typing web game. Browser-only, single user, text-based.

## Features

- RTL/LTR support (Persian and English)
- Live typing metrics (WPM, accuracy, time, characters)
- Monochromatic color scheme with customizable hue
- Adjustable font size
- Custom text input
- Race history with localStorage persistence
- JSON export/import for all data
- Khayyam quatrains for Persian typing
- Mindfulness quotes for English typing

## Usage

```sh
make install   # Install dependencies
make dev       # Start development server
make build     # Build for production
make preview   # Preview production build
```

## Requirements

- [Bun](https://bun.sh/) runtime

## Structure

```
src/
  lib/
    i18n.js       # Internationalization
    storage.js    # localStorage utilities
    styles.css    # Global styles (HSL-based)
    texts.js      # Text collections by language/difficulty
  routes/
    +layout.js    # Prerender config
    +layout.svelte
    +page.svelte  # Main app
```

## License

MIT
