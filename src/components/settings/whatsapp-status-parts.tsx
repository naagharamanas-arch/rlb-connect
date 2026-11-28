'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, Zap } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ConnectionState } from '@/lib/whatsapp/connection-status';

/** Minimal translator shape so these parts render with a plain function in tests. */
export type Translate = (key: string) => string;

export type CustomBannerState =
  | 'coexistence_live'
  | 'coexistence_attention'
  | 'test_number'
  | 'unknown';

const BANNER: Record<
  CustomBannerState,
  { title: string; desc: string; tone: 'ok' | 'warn' | 'neutral' }
> = {
  coexistence_live: { title: 'coexistenceLive', desc: 'coexistenceLiveDesc', tone: 'ok' },
  coexistence_attention: {
    title: 'coexistenceAttention',
    desc: 'coexistenceAttentionDesc',
    tone: 'warn',
  },
  test_number: { title: 'testNumber', desc: 'testNumberDesc', tone: 'ok' },
  unknown: { title: 'statusUnknown', desc: 'statusUnknownDesc', tone: 'neutral' },
};

export function isCustomBannerState(state: ConnectionState): state is CustomBannerState {
  return state in BANNER;
}

/**
 * Registration banner for the states WA_STATUS_V2 changes (coexistence, Meta
 * test number, unknown). It never says "Not registered" and never tells the
 * user to enter a PIN. Cloud API numbers keep the legacy banner.
 */
export function ConnectionStatusBanner({
  state,
  t,
  onVerify,
  verifying,
  children,
}: {
  state: CustomBannerState;
  t: Translate;
  onVerify: () => void;
  verifying: boolean;
  children?: ReactNode;
}) {
  const spec = BANNER[state];
  const cls =
    spec.tone === 'ok'
      ? 'bg-emerald-950/30 border-emerald-700/50'
      : spec.tone === 'warn'
        ? 'bg-amber-950/30 border-amber-700/50'
        : 'bg-card border-border';
  const titleCls =
    spec.tone === 'ok'
      ? 'text-emerald-200'
      : spec.tone === 'warn'
        ? 'text-amber-200'
        : 'text-foreground';
  return (
    <Alert className={cls} data-connection-state={state}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          {spec.tone === 'ok' ? (
            <CheckCircle2 className="size-4 text-emerald-400" />
          ) : spec.tone === 'warn' ? (
            <AlertTriangle className="size-4 text-amber-400" />
          ) : (
            <Info className="size-4 text-muted-foreground" />
          )}
          <AlertTitle className={'mb-0 ' + titleCls}>{t(spec.title)}</AlertTitle>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onVerify}
          disabled={verifying}
          className="border-border bg-transparent text-foreground hover:bg-muted h-7"
        >
          {verifying ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
          {t('verifyWithMeta')}
        </Button>
      </div>
      <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
        {t(spec.desc)}
      </AlertDescription>
      {children}
    </Alert>
  );
}

/**
 * Two-step PIN field. With `show` true and `neutralHint` false this is
 * exactly the markup the page always had (flag off, no-config form, known
 * Cloud API numbers). `show` false removes it (coexistence / test numbers);
 * `neutralHint` swaps the hint for wording that does not push a PIN on a
 * number whose kind is unknown.
 */
export function PinField({
  show,
  neutralHint,
  value,
  onChange,
  t,
  hintHtml,
}: {
  show: boolean;
  neutralHint: boolean;
  value: string;
  onChange: (next: string) => void;
  t: Translate;
  /** Legacy hint text (rendered as HTML, like before). */
  hintHtml: string;
}) {
  if (!show) return null;
  return (
    <div className="space-y-2">
      <Label className="text-muted-foreground">
        {t('twoStepPin')}
        <span className="ml-1 text-muted-foreground">{t('optional')}</span>
      </Label>
      <Input
        type="text"
        inputMode="numeric"
        maxLength={6}
        placeholder={t('pinPlaceholder')}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
      />
      <p className="text-xs text-muted-foreground leading-relaxed">
        {neutralHint ? (
          t('pinHintNeutral')
        ) : (
          <span dangerouslySetInnerHTML={{ __html: hintHtml }} />
        )}
      </p>
    </div>
  );
}
