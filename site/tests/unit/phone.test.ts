import { describe, expect, it } from 'vitest';
import { displayPhone, maskPhone, normalizeKenyanPhone } from '@/lib/payments/phone';

describe('normalizeKenyanPhone', () => {
  it.each([
    ['0712345678', '254712345678'],
    ['0712 345 678', '254712345678'],
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['712345678', '254712345678'],
    ['(0712) 345-678', '254712345678'],
    ['0110345678', '254110345678'],
    ['+254 110 345 678', '254110345678'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeKenyanPhone(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['0812345678', 'not a mobile prefix'],
    ['071234567', 'too short'],
    ['07123456789', 'too long'],
    ['+255712345678', 'Tanzanian number'],
    ['07l2345678', 'letter in it'],
    ['abc', 'not a number'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizeKenyanPhone(input)).toBeNull();
  });
});

describe('display helpers', () => {
  it('formats a normalised number for people', () => {
    expect(displayPhone('254712345678')).toBe('0712 345 678');
  });
  it('masks the middle digits', () => {
    expect(maskPhone('254712345678')).toBe('0712 ••• 678');
  });
});
