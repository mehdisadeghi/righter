# Righter

A touch typing web game with RTL support. Uses Khayyam quatrains in supported languages.

This work is entirely generated as an experiment by commanding Claude Code in a span of few weeks.
Technical and UX choices are mine, implementation details are done by Claude Code, and not thoroughly reviewed.


## Features
- RTL/LTR support (picks up browser's language by default)
- Live typing metrics (WPM, accuracy, time, characters)
- Monochromatic color scheme with customizable hue
- Race history with localStorage persistence
- JSON export/import for all data
- Very experimental Nostr-based multiplayer mode (works only if you're on the same relay)


## How to Run

Visit [righter.uk](https://righter.uk) or run locally:

```sh
make dev       # Start dev server
```

Then start typing. 

Requires [Bun](https://bun.sh/).

## How to Play

Open the web page and start typing. Esc will reset the text. Input text changes based on the selected
language. You can switch between ISO/ASCII layouts. Check out the settings panel for font and UI settings.

## Credits
Omar Khayyam (1048-1131), Persian poet and polymath.
Built with Svelte 5, SvelteKit, Three.js, Troika, opentype.js, nostr-tools, Yjs
Fonts: Vazirmatn (Saber Rastikerdar), Helvetiker (Three.js)
Texts: Omar Khayyam (FA), Shahriar Shahriari (EN), Unknown (DE)

Inspired by https://play.typeracer.com/

## Known Issues

- Safari: Arabic/Persian letters may appear disconnected when highlighted for typing errors.
- Performance: Disable 3D background in settings if experiencing lag.

## Maintenance

The work is not meant to be maintained, unless reviewed throughly which I don't have time for it.


## License

Righter by Mehdi Sadeghi is marked CC0 1.0. To view a copy of this mark, visit https://creativecommons.org/publicdomain/zero/1.0/
