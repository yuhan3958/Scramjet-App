FROM node:18-alpine

ENV NODE_ENV=production
ARG PNPM_VERSION=10.18.3
ARG NPM_BUILD="pnpm install --frozen-lockfile --prod"
EXPOSE 8080/tcp

LABEL maintainer="Mercury Workshop"
LABEL summary="Scramjet Demo Image"
LABEL description="Example application of Scramjet"

WORKDIR /app

RUN npm install -g pnpm@${PNPM_VERSION}

COPY ["package.json", "pnpm-lock.yaml", "./"]
RUN apk add --upgrade --no-cache python3 make g++
RUN $NPM_BUILD

COPY . .

ENTRYPOINT [ "node" ]
CMD ["src/index.js"]
