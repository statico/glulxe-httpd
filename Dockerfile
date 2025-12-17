FROM alpine:3 AS base

RUN apk add --no-cache --virtual build-deps gcc make musl-dev unzip curl

WORKDIR /build/

RUN curl -L -q https://github.com/erkyrath/cheapglk/archive/master.zip >cheapglk.zip && \
  unzip cheapglk.zip && \
  mv cheapglk-master cheapglk && \
  cd cheapglk && \
  make -j8 && \
  cd /build

RUN curl -L -q https://github.com/erkyrath/glulxe/archive/master.zip >glulxe.zip && \
  unzip glulxe.zip && \
  mv glulxe-master glulxe && \
  cd glulxe && \
  sed -i 's/arc4random()/((unsigned int)random())/g' osdepend.c && \
  make -j8 && \
  cd /build

FROM node:24-alpine

RUN npm install -g pnpm

COPY --from=base /build/glulxe/glulxe /usr/local/bin/glulxe

WORKDIR /app/

COPY package.json pnpm-lock.yaml server.mjs ./
RUN pnpm install --frozen-lockfile
EXPOSE 8080
CMD ["pnpm", "start", "-x", "/usr/local/bin/glulxe", "-c", "/out.csv", "-p", "8080", "/story.ulx"]