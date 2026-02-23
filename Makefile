.PHONY: install dev build preview clean fmt deploy bump help

BUN := ~/.bun/bin/bun

help:
	@echo "Righter - Touch Typing Game"
	@echo ""
	@echo "Usage:"
	@echo "  make install   Install dependencies"
	@echo "  make dev       Start development server"
	@echo "  make build [BASE=/path]  Build for production (BASE for subpath hosting)"
	@echo "  make preview   Preview production build"
	@echo "  make fmt       Format code (Svelte/JS/HTML/CSS)"
	@echo "  make deploy    Build and deploy to Cloudflare Pages"
	@echo "  make bump      Bump patch version"
	@echo "  make clean     Remove build artifacts"
	@echo ""

install:
	$(BUN) install

dev:
	$(BUN) run dev --host 0.0.0.0

build:
	BASE_PATH=$(BASE) $(BUN) run build

preview:
	$(BUN) run preview

fmt:
	$(BUN) x prettier --write "src/**" "*.js" "*.json"

clean:
	rm -rf build .svelte-kit node_modules/.vite

deploy: build
	$(BUN) x wrangler pages deploy build --project-name=righter

bump:
	npm version patch --no-git-tag-version
	@echo "Version bumped to $$(jq -r .version package.json)"
