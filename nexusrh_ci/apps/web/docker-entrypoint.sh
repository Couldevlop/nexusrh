#!/bin/sh
set -e
# Inject kube-dns resolver IP at runtime so proxy_pass doesn't block nginx startup
DNS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
echo "resolver ${DNS:-10.43.0.10} valid=5s ipv6=off;" > /tmp/kube-resolver.conf
exec nginx -g 'daemon off;'
