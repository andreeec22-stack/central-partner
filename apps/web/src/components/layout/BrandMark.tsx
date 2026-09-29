import { useState } from 'react';

// Workspace logo + name. Without a logo (or if it fails to load) it falls back
// to the three semaphore dots, the product's own mark.
export function BrandMark({ name, logoUrl, tagline }: { name: string; logoUrl?: string | null; tagline?: string | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  const showLogo = logoUrl && broken !== logoUrl;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-white/10">
        {showLogo ? (
          <img src={logoUrl} alt="" className="size-full bg-white object-contain p-1" onError={() => setBroken(logoUrl)} />
        ) : (
          <span className="flex gap-[3px]">
            <span className="size-1.5 rounded-full bg-sem-green" />
            <span className="size-1.5 rounded-full bg-sem-yellow" />
            <span className="size-1.5 rounded-full bg-sem-red" />
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-extrabold tracking-tight text-white">{name}</span>
        {tagline && <span className="block truncate text-[11px] text-white/50">{tagline}</span>}
      </span>
    </div>
  );
}
