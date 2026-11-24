// Hard rule: DInstinct never handles bank information, with any model (cloud or local).
// No card numbers, CVC, expiry, IBAN, account/routing/sort codes, SWIFT/BIC or PINs are
// stored in the vault, typed into websites, or passed to the AI. This is enforced here in
// code, not just asked of the model. Purchases may only use a payment method the owner has
// already saved on the merchant's own site, after confirm_purchase.

export const BANK_RULE =
  "DInstinct never handles bank information (card numbers, CVC, expiry, IBAN, account or routing numbers, PINs).";

const BANK_WORDS =
  /(credit|debit)?.?card.?(number|no|num)|cardnumber|\bcc.?(num|number|csc|cvv|exp)|\bcvv|\bcvc|\bcsc\b|security.?code|card.?code|expir|\bexp.?(date|month|year)|\biban\b|\bswift\b|\bbic\b|routing|sort.?code|account.?(number|no|num)|acct|bank|\bpin\b|pin.?code|\bcard\b/i;

/** Does a field key / label look like bank or card data? */
export function isBankField(text: string): boolean {
  return BANK_WORDS.test(text.replace(/[_\-.]/g, " "));
}

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function ibanValid(s: string): boolean {
  const v = s.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const moved = (v.slice(4) + v.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gi;

/** Does a value look like a card number or IBAN? */
export function looksLikeBankValue(value: string): boolean {
  for (const m of value.match(CARD_RE) ?? []) if (luhn(m.replace(/\D/g, ""))) return true;
  for (const m of value.match(IBAN_RE) ?? []) if (ibanValid(m)) return true;
  return false;
}

/** Removes card numbers and IBANs from chat text before it reaches the AI. */
export function redactBank(text: string): { text: string; found: boolean } {
  let found = false;
  let out = text.replace(CARD_RE, (m) => (luhn(m.replace(/\D/g, "")) ? ((found = true), "[removed: card number]") : m));
  out = out.replace(IBAN_RE, (m) => (ibanValid(m) ? ((found = true), "[removed: bank account]") : m));
  return { text: out, found };
}

/** Throws if a vault entry would hold bank information. */
export function assertNoBankInfo(fields: Record<string, string>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (isBankField(k)) throw new Error(`${BANK_RULE} The field "${k}" isn't allowed.`);
    if (v && looksLikeBankValue(v)) throw new Error(`${BANK_RULE} A value looks like a card or bank account number.`);
  }
}
