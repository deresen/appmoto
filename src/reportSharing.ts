const REPORT_ID_CHARACTERS = /[^A-Za-z0-9_-]/;

export function validReportId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !REPORT_ID_CHARACTERS.test(value);
}

export function readReportLink(search: string): { id: string | null; invalid: boolean } {
  const values = new URLSearchParams(search).getAll("segnalazione");
  if (values.length === 0) return { id: null, invalid: false };
  if (values.length !== 1 || !validReportId(values[0])) return { id: null, invalid: true };
  return { id: values[0], invalid: false };
}

/** Share only the public report ID, never the current URL's other parameters. */
export function buildReportShareUrl(origin: string, id: string): string {
  if (!validReportId(id)) throw new TypeError("Identificativo della segnalazione non valido.");
  const base = new URL(origin);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new TypeError("La condivisione richiede un indirizzo HTTP o HTTPS.");
  }
  const url = new URL("/", base.origin);
  url.searchParams.set("segnalazione", id);
  return url.toString();
}
