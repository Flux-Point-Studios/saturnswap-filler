#!/usr/bin/env bash
# This repo is PUBLIC. A mainnet credential committed here is disclosed permanently.
#
# A ceremony's applied script hash IS the credential IS the address: publish one and anyone can
# derive the order and reward addresses and watch that client's book on any explorer, attributably.
# It cannot be unpublished, and rotating it means a new paid ceremony instance.
#
# This happened on 2026-08-26 — a real registered mainnet credential and a client label reached a
# public branch inside a code comment explaining a hash derivation. The explanation did not need
# the live value; a synthetic vector says the same thing.
#
# Refuses on the ONE thing that is unambiguous: a 56-hex credential that a live chain index knows
# about is checked at review time, not here. Here we catch the shapes that are never right in a
# public repo, cheaply and with no network.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 0
fail=0
# The published BIP-39 test vector's mainnet base address. Not a party's address.
ABANDON_ADDR="addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv"
say(){ printf '  %s\n' "$1" >&2; }

# Staged files by default (pre-commit); an explicit list in CI, where nothing is staged.
if [ "${1:-}" = "--files-from" ] && [ -r "${2:-}" ]; then
  files="$(cat "$2")"
else
  files="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)"
fi
[ -z "$files" ] && exit 0

for f in $files; do
  [ -f "$f" ] || continue
  case "$f" in scripts/check-public-hygiene.sh) continue;; esac

  # A client label. There is no reason for a numbered client to appear in library code.
  if grep -nEi 'mmaas-client-[0-9]|client-[0-9]+/(applied|ceremony)' "$f" >/dev/null 2>&1; then
    say "REFUSED $f names a numbered MMaaS client. This repo is public."
    grep -nEi 'mmaas-client-[0-9]|client-[0-9]+/(applied|ceremony)' "$f" | head -3 | sed 's/^/      /' >&2
    fail=1
  fi

  # A mainnet address. Preprod (addr_test/stake_test) is fine; mainnet identifies a real party.
  #
  # The BIP-39 "abandon abandon ... about" vector is exempt: it is the published test mnemonic every
  # wallet library ships, its keys belong to nobody, and it is the RIGHT thing to use in a fixture.
  # Exempting it by exact value keeps the check meaningful — a blanket allow for "addresses in test
  # files" would have let the real one through, since that is exactly where it appeared.
  if grep -nE '\b(addr1|stake1)[a-z0-9]{20,}' "$f" | grep -vF "$ABANDON_ADDR" >/dev/null 2>&1; then
    say "REFUSED $f contains a MAINNET address."
    grep -nE '\b(addr1|stake1)[a-z0-9]{20,}' "$f" | grep -vF "$ABANDON_ADDR" | head -3 | cut -c1-110 | sed 's/^/      /' >&2
    fail=1
  fi

  # A 56-hex literal described as live/mainnet in the same breath. Synthetic vectors are fine and
  # common here, so the LITERAL alone is not the signal — the claim that it is real is.
  if grep -nEi '[0-9a-f]{56}.{0,80}(live on mainnet|mainnet credential|the credential the ceremony|a credential live)' "$f" >/dev/null 2>&1; then
    say "REFUSED $f presents a 56-hex value as a live mainnet credential."
    fail=1
  fi
done

[ "$fail" = 1 ] && {
  say ""
  say "A public repo is a publication. Use a synthetic vector or a preprod value; if a real one is"
  say "genuinely required, that is a decision to take deliberately, not in a commit."
  exit 1
}
exit 0
