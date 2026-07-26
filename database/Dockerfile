FROM postgres:16.4-alpine3.20

RUN apk add --no-cache musl-locales musl-locales-lang tzdata

# Alpine does not ship locale data by default, which makes initdb warn and fall
# back implicitly. Keep initialization deterministic and avoid trust-auth
# warnings on new data directories. POSTGRES_INITDB_ARGS can still be overridden
# by an operator when a different locale or authentication policy is required.
ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    POSTGRES_INITDB_ARGS="--locale=en_US.UTF-8 --encoding=UTF8 --auth-local=scram-sha-256 --auth-host=scram-sha-256"
