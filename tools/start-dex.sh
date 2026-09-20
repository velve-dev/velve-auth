#!/bin/sh
# The acceptance case for provider sign-up runs against a real OIDC provider rather than a stub
# (E-1903). Both the gate and the release tiers need it, and it is a script rather than two copies
# of the same block because a copy drifts — which is the argument E-1429 made for the release
# calling ci.yml instead of restating it. The release found the omission the expensive way: the
# step was in one workflow and not the other, and `tiers` failed on a tag (E-1906).
set -eu

IMAGE="dexidp/dex:v2.44.0"
NAME="velve-dex"
PROBE="http://127.0.0.1:5556/dex/.well-known/openid-configuration"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 5556:5556 \
	-v "$(pwd)/test/dex/config.yaml:/etc/dex/config.yaml" \
	"$IMAGE" dex serve /etc/dex/config.yaml >/dev/null

for _ in $(seq 1 30); do
	if curl -sf "$PROBE" >/dev/null 2>&1; then
		echo "dex: answering at $PROBE"
		exit 0
	fi
	sleep 1
done

echo "dex did not come up within 30 s" >&2
docker logs "$NAME" >&2 || true
exit 1
