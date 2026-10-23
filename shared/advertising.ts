export const AD_PLACEMENTS = ["afterMap", "footer"] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];

export interface AdvertisingConfig {
  enabled: boolean;
  publisherId: string;
  clientId: string;
  slots: Record<AdPlacement, string>;
  cmpScriptUrl: string;
}

export interface TcfConsentData {
  cmpStatus?: string;
  eventStatus?: string;
  gdprApplies?: boolean;
  listenerId?: number;
  purpose?: { consents?: Record<string, boolean> };
  vendor?: { consents?: Record<string, boolean> };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizePublisherId(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = /^(?:ca-)?pub-(\d{16})$/.exec(value.trim());
  return match ? `pub-${match[1]}` : "";
}

export function parseAdvertisingConfig(value: unknown): AdvertisingConfig {
  const input = record(value);
  const publisherId = normalizePublisherId(input.publisherId);
  const inputSlots = record(input.slots);
  const slots = Object.fromEntries(AD_PLACEMENTS.map(placement => {
    const value = inputSlots[placement];
    return [placement, typeof value === "string" && value.length >= 1 && value.length <= 20 && !/\D/.test(value) ? value : ""];
  })) as Record<AdPlacement, string>;
  let cmpScriptUrl = "";
  if (publisherId && typeof input.cmpScriptUrl === "string" && input.cmpScriptUrl) {
    try {
      const url = new URL(input.cmpScriptUrl);
      if (url.protocol === "https:" && url.hostname === "fundingchoicesmessages.google.com"
        && !url.username && !url.password && !url.port && !url.hash
        && url.pathname === `/i/${publisherId}` && url.search === "?ers=1") {
        cmpScriptUrl = url.href;
      }
    } catch { /* Invalid configuration leaves advertising disabled. */ }
  }
  return {
    enabled: input.enabled === true,
    publisherId,
    clientId: publisherId ? `ca-${publisherId}` : "",
    slots,
    cmpScriptUrl,
  };
}

export function isAdvertisingConfigured(config: AdvertisingConfig): boolean {
  return Boolean(config.enabled && config.clientId && config.cmpScriptUrl
    && AD_PLACEMENTS.some(placement => config.slots[placement]));
}

/** Deliberately restrictive: only explicit Google/personalisation consent is used. */
export function hasAdvertisingConsent(value: unknown): boolean {
  const data = record(value);
  const purposes = record(record(data.purpose).consents);
  const vendors = record(record(data.vendor).consents);
  return data.cmpStatus === "loaded"
    && (data.eventStatus === "tcloaded" || data.eventStatus === "useractioncomplete")
    && data.gdprApplies === true
    && purposes["1"] === true && purposes["3"] === true && purposes["4"] === true
    && vendors["755"] === true;
}

export function advertisingOwnership(value: unknown) {
  const publisherId = normalizePublisherId(record(value).publisherId);
  return publisherId ? {
    clientId: `ca-${publisherId}`,
    adsTxt: `google.com, ${publisherId}, DIRECT, f08c47fec0942fa0\n`,
  } : null;
}
