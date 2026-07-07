// Canonical cardano-swaps price math. The swap price is a Rational (Ask/Offer for
// one-way, Asset2/Asset1 & Asset1/Asset2 for two-way). The validator's price gate is
// the rounding-safe cross-multiplication (one_way_swap/utils.ak valid_swap):
//
//   offer_taken * price_num <= ask_given * price_den
//
// so the minimal maker-favorable deposit for taking `offer_taken` of the offer is the
// CEIL of offer_taken * num / den. BigInt throughout (Plutus integers are bignums).

export interface Rational {
  num: bigint;
  den: bigint;
}

/** Minimal ask asset the taker must deposit to take `offerTaken` of the offer, at
 *  price num/den. Ceiling division — favors the maker and always satisfies priceOk. */
export function askGivenFor(offerTaken: bigint, price: Rational): bigint {
  if (price.den <= 0n) throw new Error("price denominator must be > 0");
  if (price.num <= 0n) throw new Error("price numerator must be > 0");
  if (offerTaken < 0n) throw new Error("offerTaken must be >= 0");
  return (offerTaken * price.num + price.den - 1n) / price.den;
}

/** The on-chain price check: offer_taken * price_num <= ask_given * price_den. */
export function priceOk(offerTaken: bigint, askGiven: bigint, price: Rational): boolean {
  return offerTaken * price.num <= askGiven * price.den;
}
