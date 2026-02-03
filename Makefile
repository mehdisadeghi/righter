.PHONY: install dev build preview clean fmt help

BUN := ~/.bun/bin/bun

help:
	@echo "Righter - Touch Typing Game"
	@echo ""
	@echo "Usage:"
	@echo "  make install   Install dependencies"
	@echo "  make dev       Start development server"
	@echo "  make build     Build for production"
	@echo "  make preview   Preview production build"
	@echo "  make fmt       Format code (Svelte/JS/HTML/CSS)"
	@echo "  make clean     Remove build artifacts"
	@echo ""

install:
	$(BUN) install

dev:
	$(BUN) run dev --host 0.0.0.0

build:
	$(BUN) run build

preview:
	$(BUN) run preview

fmt:
	$(BUN) x prettier --write "src/**" "*.js" "*.json"

clean:
	rm -rf build .svelte-kit node_modules/.vite
