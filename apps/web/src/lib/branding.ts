import { useEffect } from 'react';
import { useBranding } from './queries';
import type { BrandColors, Branding } from './types';
import { useAuth } from '../stores/auth';

// Brand colors are CSS variables (styles.css); semaphore colors are fixed on purpose.
const VARS: Record<keyof BrandColors, string> = {
  primary: '--cp-primary',
  success: '--cp-success',
  warning: '--cp-warning',
  danger: '--cp-danger',
};

export function applyBrandColors(colors: BrandColors, root: HTMLElement = document.documentElement) {
  for (const [key, cssVar] of Object.entries(VARS) as [keyof BrandColors, string][]) root.style.setProperty(cssVar, colors[key]);
}

// The login screen has no session yet; it shows the last workspace's name and
// logo from this per-browser copy. Purely cosmetic, so failures are ignored.
const LAST_KEY = 'cp:last-branding';
export type LastBranding = Pick<Branding, 'workspaceName' | 'tagline' | 'logoUrl' | 'colors'>;

export function readLastBranding(): LastBranding | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? (JSON.parse(raw) as LastBranding) : null;
  } catch {
    return null;
  }
}

function rememberBranding(b: Branding) {
  try {
    const { workspaceName, tagline, logoUrl, colors } = b;
    localStorage.setItem(LAST_KEY, JSON.stringify({ workspaceName, tagline, logoUrl, colors }));
  } catch {
    // storage unavailable (private mode): nothing to remember
  }
}

// Current workspace branding, applied to the whole app as it changes (edits
// by an admin reach every open tab through the branding:updated event).
export function useWorkspaceBranding() {
  const workspaceId = useAuth((s) => s.workspace?.id);
  const branding = useBranding(workspaceId);
  useEffect(() => {
    if (!branding.data) return;
    applyBrandColors(branding.data.colors);
    rememberBranding(branding.data);
  }, [branding.data]);
  return branding.data;
}
