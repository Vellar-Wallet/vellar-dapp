# Combined backend (@vellar/all-in-one) for Railway.
#
# Root-context build: this is a pnpm workspace monorepo, so the build needs
# the root lockfile/workspace files to resolve @vellar/all-in-one's
# workspace:* dependencies. Railway's service root directory must stay the
# repo root, not a subdirectory.
#
# pnpm is installed via plain `npm install -g` instead of corepack: Railway's
# Nixpacks/Railpack builders force corepack@0.24.1, which crashes loading
# pnpm 11.9.0 with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING (a documented
# Nixpacks/pnpm-11 incompatibility). This Dockerfile bypasses that path
# entirely.
FROM node:22-bookworm-slim

WORKDIR /app

RUN npm install -g pnpm@11.9.0

# apps/extension's postinstall (wxt prepare) needs its entrypoints/ source
# dir to exist, not just its package.json, so a package.json-only prefetch
# layer (the usual pnpm/Docker caching trick) fails here. Copy full source
# before installing instead — this build isn't cached across dependency-only
# changes, but it's a backend service build, not a hot iteration loop.
COPY . .

RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production

EXPOSE 8080

CMD ["pnpm", "--filter", "@vellar/all-in-one", "start"]
