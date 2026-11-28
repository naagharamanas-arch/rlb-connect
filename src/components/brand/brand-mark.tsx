import Image from "next/image";

import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

// The RLB symbol (handshake + horns). In dark mode the dark-green half would
// vanish on a dark surface, so it sits on a light chip there.
export function BrandMark({
  size = 32,
  alt = BRAND.name,
  className,
}: {
  size?: number;
  alt?: string;
  className?: string;
}) {
  return (
    <Image
      src={BRAND.symbolSrc}
      alt={alt}
      width={size}
      height={size}
      className={cn(
        "shrink-0 object-contain dark:rounded-md dark:bg-[#f5f0e6] dark:p-0.5",
        className,
      )}
    />
  );
}
