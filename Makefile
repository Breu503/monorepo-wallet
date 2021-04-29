### Deploy configs
BRANCH=$(shell git rev-parse --abbrev-ref HEAD)
GITHASH=$(shell git rev-parse --short HEAD)
REMOTE=$(shell git remote show origin -n | grep Push | cut -f6 -d' ')
REMOTE_HASH=$(shell git ls-remote $(REMOTE) $(BRANCH) | head -n1 | cut -f1)
project=walletconnect
redisImage=redis:6-alpine
standAloneRedis=xredis
caddyImage=$(project)/caddy:$(BRANCH)
relayImage=$(project)/relay:$(BRANCH)
wakuImage=$(project)/waku:master

## Environment variables used by the compose files
include setup
export $(shell sed 's/=.*//' setup)
export PROJECT = $(project)
export RELAY_IMAGE=$(relayImage)
export CADDY_IMAGE=$(caddyImage)
export WAKU_IMAGE=$(wakuImage)

### Makefile internal coordination
logg_end=@echo "MAKE: Done with $@"; echo
flags=.makeFlags
VPATH=$(flags):build
$(shell mkdir -p $(flags))
.PHONY: help clean clean-all reset

# Shamelessly stolen from https://www.freecodecamp.org/news/self-documenting-makefile
help: ## Show this help
	@egrep -h '\s##\s' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

pull: ## downloads docker images
	docker pull $(redisImage)
	@touch $(flags)/$@
	@echo "MAKE: Done with $@"
	@echo

setup: ## configures domain and certbot email
	@read -p 'Relay URL domain: ' relay; \
	echo "export RELAY_URL="$$relay > setup
	@read -p 'Email for SSL certificate (default noreply@gmail.com): ' email; \
	echo "export CERTBOT_EMAIL="$$email >> setup
	@read -p 'Paste your cloudflare API token: ' cf; \
	echo "export CLOUDFLARE="$${cf} >> setup
	@echo ${RELAY_URL}
	@touch $(flags)/$@
	$(log_end)

bootstrap-lerna: ## setups lerna for the monorepo management
	npm i
	npx lerna link
	npx lerna bootstrap
	@touch $(flags)/$@
	$(log_end)

nix-volume:
	docker volume create nix-store
	$(log_end)

build-relay-dockerized: nix-volume ## builds relay docker image
	mkdir -p build
	git archive --format=tar.gz -o build/relay.tar.gz --prefix=relay/ HEAD
	docker run --name builder --rm \
		-v nix-store:/nix \
		-v $(shell pwd):/src \
		-w /src \
		nixos/nix nix-shell \
		-p bash \
		--run "nix-build \
			--attr docker \
			--verbose \
			&& cp -L result /src/build"
	$(eval srcImage = $(shell docker load -i build/result | awk '{print $$3}'))
	docker tag $(srcImage) $(relayImage)
	$(log_end)

build-relay: ## builds the relay system local npm
	nix-build \
		-o build/$@ \
		--attr docker \
		--argstr githash $(GITHASH)
	docker load -i build/$@ \
		| awk '{print $$NF}' \
		| tee build/$@-img \
		| xargs -I {} docker tag {} $(relayImage)
	$(log_end)

build-caddy: ## builds caddy docker image
	nix-build \
		https://github.com/sbc64/nix-caddy/archive/master.tar.gz \
		-o build/$@ \
		--attr docker
	docker load -i build/$@ \
		| awk '{print $$NF}' \
		| tee build/$@-img \
		| xargs -I {} docker tag {} $(caddyImage)
	$(log_end)

dirs:
	mkdir -p build
	mkdir -p $(flags)

build: dirs build-caddy build-relay ## builds all the packages and the containers for the relay
	$(log_end)

test-client: build-lerna ## runs "./packages/client" tests against the locally running relay. Make sure you run 'make dev' before.
	npm run test --prefix packages/client

test-staging: build-lerna ## tests client against staging.walletconnect.org
	TEST_RELAY_URL=wss://staging.walletconnect.org npm run test --prefix packages/client

test-production: build-lerna ## tests client against relay.walletconnect.org
	TEST_RELAY_URL=wss://relay.walletconnect.org npm run test --prefix packages/client

test-relay: build-relay## runs "./servers/relay" tests against the locally running relay. Make sure you run 'make dev' before.
	npm run test --prefix servers/relay

start-dbs: secret ## starts redis docker container for local development
	docker run --rm --name $(standAloneRedis) -d -p 6379:6379 $(redisImage) || true
	$(log_end)

ci: ## runs tests in github actions
	printf "export RELAY_URL=\nexport CERTBOT_EMAIL=\nexport CLOUDFLARE=false\n" > setup
	NODE_ENV=development $(MAKE) deploy
	sleep 15
	docker service logs --tail 100 $(project)_caddy
	docker service logs --tail 100 $(project)_relay
	TEST_RELAY_URL=wss://localhost $(MAKE) test-client
	TEST_RELAY_URL=wss://localhost $(MAKE) test-relay


predeploy: dirs setup pull build 

deploy: predeploy ## same as deploy but also has monitoring stack
	bash ops/deploy.sh
	$(log_end)

deploy-no-monitoring: predeploy ## same as deploy but also has monitoring stack
	MONITORING=false bash ops/deploy.sh
	$(log_end)

redeploy: clean predeploy ## redeploys the prodution containers and rebuilds them
	docker service update --force --image $(caddyImage) $(project)_caddy
	docker service update --force --image $(relayImage) $(project)_relay

relay-logs: ## follows the relay container logs. Doesn't work with 'make dev'
	docker service logs -f --raw --tail 100 $(project)_relay

cachix: clean build
	cachix push walletconnect build/build-relay
	cachix push walletconnect build/build-caddy

rm-dbs: ## stops the redis container
	docker stop $(standAloneRedis) || true
	docker stop $(standAlonePg) || true

down: stop ## alias of stop

stop: rm-dbs ## stops the whole docker stack
	docker stack rm $(project)
	while [ -n "`docker network ls --quiet --filter label=com.docker.stack.namespace=$(project)`" ]; do echo -n '.' && sleep 1; done
	@echo
	$(log_end)

reset: clean ## removes setup
	rm -f setup
	$(log_end)

clean: ## removes all build outputs
	rm -rf .makeFlags build
	$(log_end)
