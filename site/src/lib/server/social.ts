import { getRuntime } from './payments';

export const SOCIAL_NETWORKS = [
  { key: 'instagram', label: 'Instagram', env: 'SOCIAL_INSTAGRAM' },
  { key: 'tiktok', label: 'TikTok', env: 'SOCIAL_TIKTOK' },
  { key: 'facebook', label: 'Facebook', env: 'SOCIAL_FACEBOOK' },
  { key: 'twitter', label: 'X (Twitter)', env: 'SOCIAL_TWITTER' },
] as const;

export interface SocialLink {
  key: (typeof SOCIAL_NETWORKS)[number]['key'];
  label: string;
  /** Empty until the account exists and its link is saved in Settings → Social media. */
  url: string;
}

/** The social links as saved in the admin (or the host's environment). */
export function socialLinks(): SocialLink[] {
  const env = getRuntime().env;
  return SOCIAL_NETWORKS.map((n) => {
    const raw = env[n.env]?.trim() ?? '';
    return { key: n.key, label: n.label, url: /^https:\/\//.test(raw) ? raw : '' };
  });
}
