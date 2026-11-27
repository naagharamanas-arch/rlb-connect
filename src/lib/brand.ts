// Single source for the product brand shown in the UI. White-label (agency
// workspaces with their own logo/name) will override these per workspace later;
// until then every screen reads the logo from here instead of hard-coding it.
export const BRAND = {
  name: "RLB Connect",
  symbolSrc: "/brand/rlb-symbol-512.png",
  lockupSrc: "/brand/rlb-lockup.png",
} as const;
