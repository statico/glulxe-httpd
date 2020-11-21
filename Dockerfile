FROM alpine:3 as base

RUN apk add --no-cache --virtual .build-deps gcc make musl-dev unzip curl
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
  make -j8 && \
  cd /build

FROM node:12-alpine

COPY --from=base /build/glulxe/glulxe /usr/local/bin/glulxe

WORKDIR /app/

COPY package.json yarn.lock server.ts ./
RUN yarn
EXPOSE 8080
CMD yarn start -x /usr/local/bin/glulxe -c /out.csv -p 8080 /story.ulx