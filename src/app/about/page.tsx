import type { Metadata } from "next";
import Link from "next/link";

// Public "About" page. Static English content on purpose: the i18n test
// suite requires every message key in all four locale catalogues, and the
// final copy (plus legal entity details) is still pending owner
// confirmation. Only facts confirmed by the product owner or verifiable
// in this repository appear here — see docs/legal/ for open items.

export const metadata: Metadata = {
  title: "About",
};

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 text-foreground">
      <h1 className="text-3xl font-semibold tracking-tight">RLB Connect</h1>
      <p className="mt-2 text-muted-foreground">by RLB Solutions</p>

      <p className="mt-6 leading-relaxed">
        RLB Connect is an AI-powered WhatsApp CRM platform: a shared team
        inbox, contact management, sales pipelines, broadcasts and
        automation for businesses that talk to their customers on WhatsApp.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Open-source attribution</h2>
      <p className="mt-3 leading-relaxed text-muted-foreground">
        RLB Connect is built on{" "}
        <a
          className="underline underline-offset-4"
          href="https://github.com/ArnasDon/wacrm"
          target="_blank"
          rel="noreferrer noopener"
        >
          WACRM
        </a>
        , an open-source project by Arnas Donauskas released under the MIT
        License. The original copyright and license notice are preserved in
        the project&apos;s LICENSE and NOTICE files.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Legal</h2>
      <p className="mt-3 leading-relaxed text-muted-foreground">
        Privacy Policy and Terms of Service are in draft and will be
        published here once the business and legal details have been
        confirmed.
      </p>

      <p className="mt-10">
        <Link className="underline underline-offset-4" href="/login">
          Sign in
        </Link>
      </p>
    </main>
  );
}
