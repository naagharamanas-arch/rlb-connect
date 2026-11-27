import Image from "next/image";

import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

// Full logo (symbol + "RLB SOLUTIONS"). The dark-green parts disappear on a
// dark surface, so in dark mode it sits on a light rounded chip.
export function BrandLockup({
  width = 120,
  alt = BRAND.name,
  className,
}: {
  width?: number;
  alt?: string;
  className?: string;
}) {
  return (
    <Image
      src={BRAND.lockupSrc}
      alt={alt}
      width={width}
      height={Math.round((width * 563) / 458)}
      priority
      className={cn(
        "object-contain dark:rounded-xl dark:bg-[#f5f0e6] dark:p-2",
        className,
      )}
    />
  );
}
