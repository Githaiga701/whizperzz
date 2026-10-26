/** Is this address in the allow-list? Exact IPv4/IPv6 match, or an IPv4 CIDR range like 41.1.2.0/24. */
export function ipAllowed(ip: string | undefined, list: readonly string[]): boolean {
  if (list.length === 0) return true;
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/, '');
  const toNum = (a: string) => a.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  return list.some((entry) => {
    if (!entry.includes('/')) return entry === ip || entry === v4;
    const [base, bitsRaw] = entry.split('/');
    const bits = Number(bitsRaw);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4) || !/^\d+\.\d+\.\d+\.\d+$/.test(base ?? '') || !(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((toNum(v4) & mask) >>> 0) === ((toNum(base!) & mask) >>> 0);
  });
}
