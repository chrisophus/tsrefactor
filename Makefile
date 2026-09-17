.PHONY: help build check test lint clean install

# Default target
.DEFAULT_GOAL := help

# Colors for output
BLUE := \033[0;34m
GREEN := \033[0;32m
NC := \033[0m # No Color

help: ## Show this help message
	@echo "$(BLUE)tsrefactor Build Targets$(NC)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'

build: ## Compile src/ to dist/ (tsc -p tsconfig.build.json)
	npm run build

check: ## typecheck + lint + knip + test, same as CI
	npm run check

test: ## Run the test suite
	npm test

lint: ## eslint .
	npm run lint

clean: ## Remove build output and installed deps
	rm -rf dist node_modules

install: ## npm ci, build, and npm link so `tsrefactor` is on PATH
	npm ci
	$(MAKE) build
	npm link
	@echo "$(GREEN)✓ installed tsrefactor → $(shell npm root -g)/../tsrefactor$(NC)"
	@echo "  verify: tsrefactor --help"
