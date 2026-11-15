FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# The hash lets scripts/dev-container.sh notice when the node_modules volume is older than the lockfile.
RUN npm ci && sha256sum package-lock.json | cut -d ' ' -f 1 > node_modules/.package-lock.sha256

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

EXPOSE 3000

CMD ["npm", "run", "dev"]
