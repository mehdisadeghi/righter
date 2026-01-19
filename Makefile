.PHONY: install dev build preview clean help

BUN := ~/.bun/bin/bun

help:
	@echo "Righter - Touch Typing Game"
	@echo ""
	@echo "Usage:"
	@echo "  make install   Install dependencies"
	@echo "  make dev       Start development server"
	@echo "  make build     Build for production"
	@echo "  make preview   Preview production build"
	@echo "  make clean     Remove build artifacts"
	@echo ""

install:
	$(BUN) install

dev:
	$(BUN) run dev

build:
	$(BUN) run build

preview:
	$(BUN) run preview

clean:
	rm -rf build .svelte-kit node_modules/.vite
