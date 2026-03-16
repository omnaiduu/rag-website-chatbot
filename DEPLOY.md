# Production Docker Deployment (Next.js) - Port 5000

This project is configured for a production multi-stage Docker image using Next.js standalone output.

Lockfile behavior in Docker build:

- If `bun.lock` exists, Docker uses Bun (`bun install --frozen-lockfile`).
- Otherwise it falls back to npm/yarn/pnpm based on detected lockfile.
- Runtime container is still Node.js.

## 1) Set production environment variables

Do not bake secrets into the Docker image. Pass them at runtime with an env file.

Create your env file:

```bash
cp .env.example .env
```

Update `.env` with real production values:

- `DATABASE_URL`
- `GROQ_API_KEY`
- `COHERE_API_KEY`
- `GROQ_MODEL` (optional)

## 2) Build the production image

The Docker builder stage uses safe temporary placeholder values during `RUN ... build` so Next.js can complete build-time route analysis. This does not replace runtime secrets.

```bash
docker build -t rag-website-chatbot:prod .
```

## 3) Run container in production (port 5000)

```bash
docker run -d \
  --name rag-website-chatbot \
  --restart unless-stopped \
  -p 5000:5000 \
  --env-file .env \
  rag-website-chatbot:prod
```

Open:

- http://localhost:5000

## 4) One-liner build and run

```bash
docker build -t rag-website-chatbot:prod . && docker rm -f rag-website-chatbot || true && docker run -d --name rag-website-chatbot --restart unless-stopped -p 5000:5000 --env-file .env rag-website-chatbot:prod
```

## 5) Useful production commands

View logs:

```bash
docker logs -f rag-website-chatbot
```

Stop:

```bash
docker stop rag-website-chatbot
```

Start again:

```bash
docker start rag-website-chatbot
```

Remove:

```bash
docker rm -f rag-website-chatbot
```

## 6) Deploy updated version

```bash
docker rm -f rag-website-chatbot || true
docker build -t rag-website-chatbot:prod .
docker run -d --name rag-website-chatbot --restart unless-stopped -p 5000:5000 --env-file .env rag-website-chatbot:prod
```

## 7) Run locally without Docker

Use this when you want to run the app directly on your machine.

### Prerequisites

- Node.js 24.x
- Bun (recommended for this repo because `bun.lock` is present)

### Step 1: Create local env file

```bash
cp .env.example .env
```

Fill `.env` with real values for:

- `DATABASE_URL`
- `GROQ_API_KEY`
- `COHERE_API_KEY`
- `GROQ_MODEL` (optional)

### Step 2: Install dependencies

With Bun (recommended):

```bash
bun install
```

With npm:

```bash
npm install
```

### Step 3: Run in development mode

With Bun:

```bash
bun run dev
```

With npm:

```bash
npm run dev
```

Open:

- http://localhost:3000

### Step 4: Run in local production mode (no Docker)

With Bun:

```bash
bun run build
PORT=5000 bun run start
```

With npm:

```bash
npm run build
PORT=5000 npm run start
```

Open:

- http://localhost:5000

## 8) Push image to GitHub Container Registry (GHCR)

Use this to store and deploy the production image from GitHub.

### Step 1: Define image variables

```bash
export GHCR_OWNER=omnaiduu
export GHCR_IMAGE=rag-website-chatbot
export GHCR_TAG=v1
```

These are shell variables used by the GHCR commands in Step 3 to Step 6.
Set them in the same terminal session before running login/build/push/pull commands.

### Step 2: Create a GitHub token

Create a Personal Access Token (classic) with:

- `write:packages`
- `read:packages`

If you will delete container versions later, also add:

- `delete:packages`

Set token in your shell (replace with your real token):

```bash
export GITHUB_TOKEN=ghp_your_token_here
```

If you use GitHub CLI, you can also do:

```bash
export GITHUB_TOKEN="$(gh auth token)"
```

Do not commit this token to any file in the repository.

### Step 3: Login to GHCR

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GHCR_OWNER" --password-stdin
```

### Step 4: Build and tag for GHCR (multi-arch: AMD64 + ARM64)

Initialize buildx once (if not already configured):

```bash
docker buildx create --name multiarch-builder --use || docker buildx use multiarch-builder
docker buildx inspect --bootstrap
```

Build and push a multi-architecture image manifest:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/$GHCR_OWNER/$GHCR_IMAGE:$GHCR_TAG \
  -t ghcr.io/$GHCR_OWNER/$GHCR_IMAGE:latest \
  --push \
  .
```

### Step 5: Push to GHCR

If you used `docker buildx build ... --push` in Step 4, this step is already done.
You can skip it.

```bash
docker push ghcr.io/$GHCR_OWNER/$GHCR_IMAGE:$GHCR_TAG
docker push ghcr.io/$GHCR_OWNER/$GHCR_IMAGE:latest
```

### Step 6: Pull and run on production server

On the production machine, store your runtime env file outside the repo, for example:

```bash
sudo mkdir -p /opt/rag-website-chatbot
sudo nano /opt/rag-website-chatbot/.env
```

Then run the container using that absolute env file path:

```bash
docker pull ghcr.io/$GHCR_OWNER/$GHCR_IMAGE:latest
docker rm -f rag-website-chatbot || true
docker run -d \
  --name rag-website-chatbot \
  --restart unless-stopped \
  -p 5000:5000 \
  --env-file /opt/rag-website-chatbot/.env \
  ghcr.io/$GHCR_OWNER/$GHCR_IMAGE:latest
```

If you still need to force architecture manually, add:

```bash
--platform linux/arm64
```

to `docker run`.

## Notes

- Container listens on port 5000 (`PORT=5000` in `Dockerfile`).
- App environment variables are injected at runtime from `.env`.
- Never commit `.env` to git.
- For ARM production machines, publish and pull multi-arch images (`linux/amd64,linux/arm64`) using buildx.
