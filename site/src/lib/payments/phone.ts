/**
 * Normalises a Kenyan mobile number to the 2547XXXXXXXX / 2541XXXXXXXX format Daraja expects.
 * Accepts 07.., 01.., 7.., 1.., +254.., 254.., with spaces, dashes or brackets.
 * Returns null when the number can't be a Kenyan mobile.
 */
export function normalizeKenyanPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;

  let local: string;
  if (digits.startsWith('254')) local = digits.slice(3);
  else if (digits.startsWith('0')) local = digits.slice(1);
  else local = digits;

  return /^[71]\d{8}$/.test(local) ? `254${local}` : null;
}

/** "254712345678" → "0712 345 678", for showing back to the guest. */
export function displayPhone(normalized: string): string {
  const local = `0${normalized.slice(3)}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

/** "254712345678" → "0712 ••• 678", safe to show in status messages. */
export function maskPhone(normalized: string): string {
  const local = `0${normalized.slice(3)}`;
  return `${local.slice(0, 4)} ••• ${local.slice(7)}`;
}
