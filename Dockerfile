FROM node:22-alpine

ENV NODE_ENV=production
ARG PNPM_VERSION=10.18.3
EXPOSE 8080/tcp

LABEL maintainer="Mercury Workshop"
LABEL summary="Scramjet 2 Novelpia Proxy"
LABEL description="Experimental Scramjet 2 proxy deployment"

WORKDIR /app

RUN npm install -g pnpm@${PNPM_VERSION}

COPY ["package.json", "pnpm-lock.yaml", "./"]
RUN pnpm install --no-frozen-lockfile --prod

COPY . .

ENTRYPOINT [ "node" ]
CMD ["src/index.js"]
