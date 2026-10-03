#!/bin/sh
# Runs from the nginx image's /docker-entrypoint.d before nginx starts.
# Writes the two files nginx.conf includes from /etc/nginx/runtime.
set -eu

mkdir -p /etc/nginx/runtime

# The container's own DNS servers (IPv6 ones in brackets, zone ids dropped).
servers=$(awk '/^nameserver/ { ip = $2; sub(/%.*/, "", ip); if (ip ~ /:/) ip = "[" ip "]"; printf "%s ", ip }' /etc/resolv.conf)
echo "resolver ${servers:-127.0.0.11} valid=10s;" > /etc/nginx/runtime/resolver.conf

# Behind Railway's edge, $remote_addr is the edge; the client is the right-most
# X-Forwarded-For entry it appended (real_ip_recursive off takes exactly that
# one, so entries a client forges to its left are ignored). Only enable it when
# nginx is reachable solely through such a proxy; docker-compose leaves it off.
if [ "${TRUST_EDGE_PROXY:-false}" = "true" ]; then
  cat > /etc/nginx/runtime/real-ip.conf <<'EOF'
set_real_ip_from 0.0.0.0/0;
set_real_ip_from ::/0;
real_ip_header X-Forwarded-For;
EOF
else
  : > /etc/nginx/runtime/real-ip.conf
fi
